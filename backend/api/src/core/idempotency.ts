import { Prisma } from "@prisma/client";
import { getPrisma } from "./db";
import { AppError } from "./errors";
import { logger } from "./logger";

/**
 * Idempotency-Key handling for mutating POSTs (§7.1: /orders, /payouts).
 *
 * Semantics (phase-1 brief):
 * - same key + same user within 24h → replay the stored response verbatim
 *   (`replayed: true`; routes answer 200 instead of 201);
 * - same key + different user → 409 IDEMPOTENCY_CONFLICT;
 * - keys older than 24h are recycled (deleted and re-claimed).
 *
 * Double-fire safety: the key row is INSERTed (PK = key) with a pending
 * sentinel BEFORE `run()` executes, so two concurrent requests with the same
 * key can never both run — the loser sees the unique violation. The real
 * response is persisted immediately after `run()`'s own TX commits (the brief
 * allows "else immediately after"); on failure the claim is released so the
 * client may retry with the same key.
 */

const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const PENDING_SENTINEL_KEY = "__medrushIdempotencyPending";

function isPendingSentinel(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    PENDING_SENTINEL_KEY in (value as Record<string, unknown>)
  );
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export interface IdempotencyResult<T> {
  /** True when the stored response was replayed instead of running `run()`. */
  replayed: boolean;
  response: T;
}

/**
 * Wrap an idempotent mutation. `run()` must resolve to a JSON-serializable
 * value (the wire-shaped response body `data`) — it is stored verbatim in
 * `IdempotencyKey.response` and replayed for 24h.
 */
export async function withIdempotency<T>(
  key: string,
  userId: string,
  run: () => Promise<T>,
): Promise<IdempotencyResult<T>> {
  const prisma = getPrisma();

  let claimedAt: Date | null = null;
  for (let attempt = 0; attempt < 3 && claimedAt === null; attempt += 1) {
    try {
      const created = await prisma.idempotencyKey.create({
        data: { key, userId, response: { [PENDING_SENTINEL_KEY]: true } },
      });
      claimedAt = created.createdAt;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const existing = await prisma.idempotencyKey.findUnique({ where: { key } });
      if (!existing) continue; // deleted between create and read — retry the claim

      if (existing.userId !== userId) {
        throw new AppError(
          "IDEMPOTENCY_CONFLICT",
          "This Idempotency-Key was already used by another user",
          409,
          { key },
        );
      }
      if (Date.now() - existing.createdAt.getTime() > REPLAY_WINDOW_MS) {
        // Expired — recycle. createdAt guard keeps a concurrent fresh claim safe.
        await prisma.idempotencyKey.deleteMany({
          where: { key, createdAt: existing.createdAt },
        });
        continue;
      }
      if (isPendingSentinel(existing.response)) {
        throw new AppError(
          "CONFLICT",
          "A request with this Idempotency-Key is still in flight",
          409,
          { key },
        );
      }
      return { replayed: true, response: existing.response as unknown as T };
    }
  }
  if (claimedAt === null) {
    throw new AppError("CONFLICT", "Could not claim the Idempotency-Key — please retry", 409, {
      key,
    });
  }

  let response: T;
  try {
    response = await run();
  } catch (error) {
    // run() rolled back (no order committed) → release the claim so the client
    // can retry the whole operation with the same key.
    await prisma.idempotencyKey
      .deleteMany({ where: { key, createdAt: claimedAt } })
      .catch(() => undefined);
    throw error;
  }

  // run() COMMITTED. The claim must never be released now: a retry has to replay
  // (or briefly get 409 in-flight), never re-execute run() — re-running would hit
  // the already-cleared cart and double-apply side effects on a committed order.
  try {
    await prisma.idempotencyKey.update({
      where: { key },
      data: { response: response as unknown as Prisma.InputJsonValue },
    });
  } catch (storeError) {
    // Response couldn't be persisted. The pending-sentinel row stays, so a retry
    // within 24h gets 409 "in flight" rather than re-running — the committed order
    // is safe. (Not replayable until the window recycles; acceptable for Phase 1.)
    logger.error({ err: storeError, key }, "idempotency: run() committed but response store failed");
  }
  return { replayed: false, response };
}
