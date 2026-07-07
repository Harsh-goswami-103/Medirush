import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Prescription upload (BLUEPRINT §7.2, §10.1, §13; phase-2 brief §5). Real
 * Postgres, R2 in STUB mode (bytes land under apps/api/.storage/private).
 * Covers: valid image → PENDING + stored; oversize → 422; spoofed content → 422;
 * foreign order → 404; non-Rx order → 422.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.R2_ACCOUNT_ID; // R2 stub mode → local filesystem

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { setupTestDb } = await import("./helpers/db");
const { appSettings, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
let app: App;

/** A real, sharp-decodable 1×1 transparent PNG (valid magic bytes + IDAT). */
const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** apps/api/.storage/private — the R2 stub root (resolved from this test file). */
const STORAGE_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", ".storage", "private");

let orderSeq = 0;
async function makeRxOrder(
  userId: string,
  overrides: Partial<Prisma.OrderUncheckedCreateInput> = {},
) {
  orderSeq += 1;
  return prisma.order.create({
    data: {
      orderNo: `MR-RXTEST-${orderSeq}`,
      userId,
      status: "RX_REVIEW",
      paymentMethod: "COD",
      paymentStatus: "COD_DUE",
      addressSnapshot: {
        name: "Test",
        phone: "+919000000000",
        line1: "1 Test Rd",
        pincode: "560001",
        lat: 12.97,
        lng: 77.59,
      } as Prisma.InputJsonValue,
      distanceM: 100,
      itemsPaise: 10000,
      deliveryPaise: 2000,
      discountPaise: 0,
      totalPaise: 12000,
      requiresRx: true,
      rxStatus: "PENDING",
      ...overrides,
    },
  });
}

function uploadFile(
  headers: Record<string, string>,
  orderId: string,
  file: { buffer: Buffer; filename: string; contentType: string },
) {
  const boundary = `----medrushTest${randomUUID().replace(/-/g, "")}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, file.buffer, tail]);
  return app.inject({
    method: "POST",
    url: `/v1/orders/${orderId}/prescriptions`,
    headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
});

beforeEach(async () => {
  await setupTestDb();
  clearAuthCaches();
  bustStoreConfigCache();
  bustFlagCache();
  await storeConfig();
  await appSettings();
});

describe("POST /v1/orders/:id/prescriptions", () => {
  it("accepts a valid PNG → Prescription PENDING, re-encoded and stored", async () => {
    const customer = await user("CUSTOMER");
    const order = await makeRxOrder(customer.id);

    const res = await uploadFile(authHeaders(customer), order.id, {
      buffer: REAL_PNG,
      filename: "rx.png",
      contentType: "image/png",
    });
    expect(res.statusCode, res.body).toBe(201);

    const rx = res.json().data;
    expect(rx.status).toBe("PENDING");
    expect(rx.mimeType).toBe("image/png");
    expect(rx.reviewedAt).toBeNull();

    // Persisted with a server-generated private key.
    const row = await prisma.prescription.findUnique({ where: { id: rx.id } });
    expect(row?.fileKey).toMatch(new RegExp(`^rx/${order.id}/[a-f0-9]+\\.png$`));
    expect(row?.status).toBe("PENDING");

    // Bytes actually landed in the R2 stub (and were re-encoded, so non-empty).
    const stored = await readFile(join(STORAGE_ROOT, row!.fileKey));
    expect(stored.length).toBeGreaterThan(0);
    // Re-encoded PNG still starts with the PNG signature.
    expect(stored.subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  it("rejects an oversized upload with 422", async () => {
    const customer = await user("CUSTOMER");
    const order = await makeRxOrder(customer.id);

    const big = Buffer.alloc(6 * 1024 * 1024, 0x89); // 6MB > 5MB ceiling
    const res = await uploadFile(authHeaders(customer), order.id, {
      buffer: big,
      filename: "big.png",
      contentType: "image/png",
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(await prisma.prescription.count()).toBe(0);
  });

  it("rejects spoofed content (png MIME, non-image bytes) with 422", async () => {
    const customer = await user("CUSTOMER");
    const order = await makeRxOrder(customer.id);

    const res = await uploadFile(authHeaders(customer), order.id, {
      buffer: Buffer.from("this is definitely not a real png"),
      filename: "fake.png",
      contentType: "image/png",
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(await prisma.prescription.count()).toBe(0);
  });

  it("returns 404 when uploading to another user's order", async () => {
    const owner = await user("CUSTOMER");
    const other = await user("CUSTOMER");
    const order = await makeRxOrder(owner.id);

    const res = await uploadFile(authHeaders(other), order.id, {
      buffer: REAL_PNG,
      filename: "rx.png",
      contentType: "image/png",
    });
    expect(res.statusCode).toBe(404);
    expect(await prisma.prescription.count()).toBe(0);
  });

  it("returns 422 when the order does not require a prescription", async () => {
    const customer = await user("CUSTOMER");
    const order = await makeRxOrder(customer.id, {
      requiresRx: false,
      rxStatus: "NA",
      status: "PLACED",
    });

    const res = await uploadFile(authHeaders(customer), order.id, {
      buffer: REAL_PNG,
      filename: "rx.png",
      contentType: "image/png",
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });
});
