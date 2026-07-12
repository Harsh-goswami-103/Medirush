import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Graceful-shutdown order (§11, Phase 7 §10): socket.io must close BEFORE the
 * HTTP server so (a) `server:restarting` reaches connected clients and (b)
 * active WebSocket upgrades cannot pin `app.close()` until the 25s hard-exit.
 *
 * SIGTERM is not reliably deliverable in-process on Windows, so this drives the
 * exported `runShutdown` directly against a REAL listening server with a REAL
 * connected socket.io session. socket.io-client is not a backend dependency —
 * the client here speaks the engine.io v4 long-polling protocol over fetch
 * (handshake → CONNECT with auth → long-poll), which exercises the identical
 * server-side emit/close path.
 */

// Env must be set BEFORE src modules load (config/logger parse eagerly on import).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { runShutdown } = await import("../src/server");
const { attachSocket } = await import("../src/core/socket");
const { getPrisma } = await import("../src/core/db");
const { setupTestDb } = await import("./helpers/db");
const { devToken } = await import("./helpers/auth");
const factories = await import("./helpers/factories");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
let app: App;
let base: string;

beforeAll(async () => {
  await setupTestDb();
  app = await buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  attachSocket(app.server);
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("no bound port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  // runShutdown already closed everything on the happy path; this is the
  // cleanup for an assertion failure part-way through.
  if (app.server.listening) await app.close();
});

/** One engine.io polling request. Packets in a payload are '\x1e'-separated. */
async function eioGet(query: string): Promise<string> {
  const res = await fetch(`${base}/socket.io/?EIO=4&transport=polling&${query}`);
  return res.text();
}

async function eioPost(query: string, body: string): Promise<string> {
  const res = await fetch(`${base}/socket.io/?EIO=4&transport=polling&${query}`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body,
  });
  return res.text();
}

describe("runShutdown", () => {
  it("delivers server:restarting to a connected client, then exits promptly", async () => {
    // A verified driver identity for the handshake (resolveSocketIdentity gate).
    const driverUser = await factories.user("DRIVER");
    await prisma.driverProfile.create({
      data: { userId: driverUser.id, isVerified: true, isOnline: true },
    });

    // engine.io open → sid.
    const open = await eioGet(`t=${Date.now()}`);
    expect(open.startsWith("0"), open).toBe(true);
    const { sid } = JSON.parse(open.slice(1)) as { sid: string };

    // socket.io CONNECT on the default namespace with the handshake token.
    const token = devToken(driverUser.firebaseUid, driverUser.phone);
    const posted = await eioPost(`t=${Date.now() + 1}&sid=${sid}`, `40${JSON.stringify({ token })}`);
    expect(posted).toBe("ok");

    // CONNECT ack (auth middleware ran; identity resolved). May take one poll.
    const ack = await eioGet(`t=${Date.now() + 2}&sid=${sid}`);
    expect(ack, ack).toContain("40{"); // '44' here would be CONNECT_ERROR

    // Park a long-poll, give the server a beat to register it, then shut down.
    const pollPromise = eioGet(`t=${Date.now() + 3}&sid=${sid}`);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const startedAt = Date.now();
    await runShutdown(app);
    const elapsedMs = Date.now() - startedAt;

    // Prompt exit: nowhere near the 25s hard-exit budget the old order burned.
    expect(elapsedMs).toBeLessThan(5_000);
    expect(app.server.listening).toBe(false);

    // The restart notice reached the still-connected client BEFORE the close.
    const poll = await pollPromise;
    expect(poll, poll).toContain('42["server:restarting"]');
  });
});
