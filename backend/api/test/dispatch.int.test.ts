import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

/**
 * Dispatch (BLUEPRINT §9.5) — wave offers, the ATOMIC single-winner accept race,
 * reject/expiry escalation. Real Postgres; the socket/job emits are null-safe
 * no-ops in tests, so the service functions run standalone.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { dispatchOrder, acceptOffer, rejectOffer, expireAndEscalate } = await import(
  "../src/modules/dispatch/service"
);
const { setupTestDb } = await import("./helpers/db");
const { STORE_LAT, STORE_LNG, product, storeConfig, user } = await import("./helpers/factories");

const prisma = getPrisma();
let seq = 0;

async function makeReadyOrder(): Promise<string> {
  seq += 1;
  const customer = await user("CUSTOMER");
  const p = await product({ stock: 50 });
  const order = await prisma.order.create({
    data: {
      orderNo: `MR-DISP-${seq}`,
      userId: customer.id,
      status: "READY",
      paymentMethod: "COD",
      paymentStatus: "COD_DUE",
      addressSnapshot: {
        name: "Cust",
        phone: "+919000000000",
        line1: "1 Test Rd",
        pincode: "560001",
        lat: STORE_LAT,
        lng: STORE_LNG,
      } as Prisma.InputJsonValue,
      distanceM: 1500,
      itemsPaise: 10000,
      deliveryPaise: 2000,
      discountPaise: 0,
      totalPaise: 12000,
      requiresRx: false,
      rxStatus: "NA",
      placedAt: new Date(),
      readyAt: new Date(),
      deliveryOtp: "1234",
      items: {
        create: [
          {
            productId: p.id,
            nameSnap: p.name,
            packSizeSnap: p.packSize,
            pricePaise: p.pricePaise,
            mrpPaise: p.mrpPaise,
            gstRatePct: p.gstRatePct,
            hsnSnap: p.hsnCode,
            requiresRx: false,
            qty: 1,
          },
        ],
      },
    },
  });
  return order.id;
}

/** Online, verified driver `km` kilometres east of the store by default. */
async function makeDriver(
  opts: { online?: boolean; verified?: boolean; km?: number } = {},
): Promise<string> {
  const u = await user("DRIVER");
  const profile = await prisma.driverProfile.create({
    data: {
      userId: u.id,
      isVerified: opts.verified ?? true,
      isOnline: opts.online ?? true,
      lastLat: STORE_LAT,
      lastLng: STORE_LNG + (opts.km ?? 0) / 100, // ~1.1km per 0.01° lng near Bengaluru
    },
  });
  return profile.id;
}

const offersFor = (orderId: string) =>
  prisma.deliveryOffer.findMany({ where: { orderId }, orderBy: { offeredAt: "asc" } });

afterAll(async () => {
  await disconnectPrisma();
});

beforeEach(async () => {
  await setupTestDb();
  bustStoreConfigCache();
  await storeConfig();
});

describe("dispatch — offers & waves", () => {
  it("offers wave 1 to the 3 nearest online+verified drivers only", async () => {
    const orderId = await makeReadyOrder();
    const d0 = await makeDriver({ km: 0 });
    const d1 = await makeDriver({ km: 1 });
    const d2 = await makeDriver({ km: 2 });
    await makeDriver({ km: 3 }); // 4th nearest — beyond wave 1
    await makeDriver({ km: 0, online: false }); // offline
    await makeDriver({ km: 0, verified: false }); // unverified

    await dispatchOrder(orderId);

    const offers = await offersFor(orderId);
    expect(offers).toHaveLength(3);
    expect(offers.every((o) => o.status === "OFFERED" && o.wave === 1)).toBe(true);
    // The three nearest got the offers.
    expect(new Set(offers.map((o) => o.driverId))).toEqual(new Set([d0, d1, d2]));
  });
});

describe("dispatch — accept race (single winner)", () => {
  it("N concurrent accepts → exactly one wins, the rest get 409 OFFER_TAKEN", async () => {
    const orderId = await makeReadyOrder();
    await makeDriver({ km: 0 });
    await makeDriver({ km: 1 });
    await makeDriver({ km: 2 });
    await dispatchOrder(orderId);

    const offers = await offersFor(orderId);
    expect(offers).toHaveLength(3);

    // All three drivers accept their offer at the same time.
    const results = await Promise.allSettled(
      offers.map((o) => acceptOffer(o.id, o.driverId)),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    // Losers get a 409 OFFER_TAKEN.
    for (const l of lost) {
      const err = (l as PromiseRejectedResult).reason as { statusCode?: number; code?: string };
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe("OFFER_TAKEN");
    }

    // Exactly one delivery, order ASSIGNED once, one ASSIGNED event.
    expect(await prisma.delivery.count({ where: { orderId } })).toBe(1);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("ASSIGNED");
    const assignedEvents = await prisma.orderEvent.findMany({ where: { orderId, to: "ASSIGNED" } });
    expect(assignedEvents).toHaveLength(1);

    // One offer ACCEPTED, the rest EXPIRED (none left OFFERED).
    const after = await offersFor(orderId);
    expect(after.filter((o) => o.status === "ACCEPTED")).toHaveLength(1);
    expect(after.filter((o) => o.status === "EXPIRED")).toHaveLength(2);
    expect(after.some((o) => o.status === "OFFERED")).toBe(false);
  });
});

describe("dispatch — escalation", () => {
  it("all wave-1 rejects escalate to a wave-2 offer for the next driver", async () => {
    const orderId = await makeReadyOrder();
    await makeDriver({ km: 0 });
    await makeDriver({ km: 1 });
    await makeDriver({ km: 2 });
    const d4 = await makeDriver({ km: 5 }); // wave-2-only (4th nearest)
    await dispatchOrder(orderId);

    const wave1 = await offersFor(orderId);
    expect(wave1).toHaveLength(3);
    // Every wave-1 driver rejects.
    for (const o of wave1) await rejectOffer(o.id, o.driverId);

    const all = await offersFor(orderId);
    // The 4th driver now has a fresh wave-2 OFFERED offer.
    const wave2 = all.filter((o) => o.wave === 2 && o.status === "OFFERED");
    expect(wave2).toHaveLength(1);
    expect(wave2[0]?.driverId).toBe(d4);
    expect(all.filter((o) => o.status === "REJECTED")).toHaveLength(3);
  });

  it("expiry expires the live offers and escalates the next wave", async () => {
    const orderId = await makeReadyOrder();
    await makeDriver({ km: 0 });
    await makeDriver({ km: 1 });
    await makeDriver({ km: 2 });
    const d4 = await makeDriver({ km: 5 });
    await dispatchOrder(orderId);

    await expireAndEscalate(orderId);

    const all = await offersFor(orderId);
    expect(all.filter((o) => o.wave === 1 && o.status === "EXPIRED")).toHaveLength(3);
    const wave2 = all.filter((o) => o.wave === 2 && o.status === "OFFERED");
    expect(wave2).toHaveLength(1);
    expect(wave2[0]?.driverId).toBe(d4);
    // Order is still awaiting a driver.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("READY");
  });
});
