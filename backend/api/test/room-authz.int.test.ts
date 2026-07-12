import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { OPS_ROOM, Role, driverRoom, orderRoom, type SocketData } from "@medrush/contracts";

/**
 * Socket room-authorization (§7.3, headline Phase-6 test): `canJoinRoom` is the
 * per-order ownership gate that prevents a customer from receiving another
 * order's `driver:location`. Real Postgres; no HTTP surface needed — the gate is
 * a pure function over the DB.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { canJoinRoom, resolveSocketIdentity } = await import("../src/core/socket");
const { setupTestDb } = await import("./helpers/db");
const { STORE_LAT, STORE_LNG, user } = await import("./helpers/factories");

const prisma = getPrisma();

async function makeOrder(userId: string): Promise<string> {
  const order = await prisma.order.create({
    data: {
      orderNo: `MR-AUTHZ-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      userId,
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
    },
  });
  return order.id;
}

afterAll(async () => {
  await disconnectPrisma();
});

beforeEach(async () => {
  await setupTestDb();
});

describe("canJoinRoom — order rooms", () => {
  it("the owning customer may join their own order room", async () => {
    const owner = await user("CUSTOMER");
    const orderId = await makeOrder(owner.id);
    const data: SocketData = { userId: owner.id, role: Role.CUSTOMER };
    expect(await canJoinRoom(data, orderRoom(orderId))).toBe(true);
  });

  it("a different customer may NOT join another order's room (no cross-order leak)", async () => {
    const owner = await user("CUSTOMER");
    const other = await user("CUSTOMER");
    const orderId = await makeOrder(owner.id);
    const data: SocketData = { userId: other.id, role: Role.CUSTOMER };
    expect(await canJoinRoom(data, orderRoom(orderId))).toBe(false);
  });

  it("staff (INVENTORY / ADMIN) may join any order room + the ops room", async () => {
    const owner = await user("CUSTOMER");
    const orderId = await makeOrder(owner.id);
    const inv: SocketData = { userId: (await user("INVENTORY")).id, role: Role.INVENTORY };
    const admin: SocketData = { userId: (await user("ADMIN")).id, role: Role.ADMIN };
    expect(await canJoinRoom(inv, orderRoom(orderId))).toBe(true);
    expect(await canJoinRoom(admin, orderRoom(orderId))).toBe(true);
    expect(await canJoinRoom(inv, OPS_ROOM)).toBe(true);
    expect(await canJoinRoom(admin, OPS_ROOM)).toBe(true);
  });

  it("a customer may NOT join the ops room", async () => {
    const cust: SocketData = { userId: (await user("CUSTOMER")).id, role: Role.CUSTOMER };
    expect(await canJoinRoom(cust, OPS_ROOM)).toBe(false);
  });
});

describe("canJoinRoom — driver rooms", () => {
  it("a driver may join only their OWN driver room", async () => {
    const data: SocketData = {
      userId: "driver-user-1",
      role: Role.DRIVER,
      driverProfileId: "profile-1",
    };
    expect(await canJoinRoom(data, driverRoom("profile-1"))).toBe(true);
    expect(await canJoinRoom(data, driverRoom("profile-2"))).toBe(false);
  });

  it("a driver may NOT join an order room they do not own", async () => {
    const owner = await user("CUSTOMER");
    const orderId = await makeOrder(owner.id);
    const data: SocketData = {
      userId: "driver-user-2",
      role: Role.DRIVER,
      driverProfileId: "profile-2",
    };
    expect(await canJoinRoom(data, orderRoom(orderId))).toBe(false);
  });
});

describe("resolveSocketIdentity — handshake driver-verification gate (§8.2 regression)", () => {
  it("an UNVERIFIED driver's socket identity carries NO driverProfileId", async () => {
    const driverUser = await user("DRIVER");
    await prisma.driverProfile.create({
      data: { userId: driverUser.id, isVerified: false },
    });

    const identity = await resolveSocketIdentity(driverUser.firebaseUid);
    expect(identity).not.toBeNull();
    expect(identity?.userId).toBe(driverUser.id);
    expect(identity?.role).toBe(Role.DRIVER);
    // Without driverProfileId the socket can neither join its driver room nor
    // push location:update — the HTTP driver gate, mirrored (§8.2).
    expect(identity?.driverProfileId).toBeUndefined();
  });

  it("a VERIFIED driver's socket identity carries driverProfileId", async () => {
    const driverUser = await user("DRIVER");
    const profile = await prisma.driverProfile.create({
      data: { userId: driverUser.id, isVerified: true },
    });

    const identity = await resolveSocketIdentity(driverUser.firebaseUid);
    expect(identity?.driverProfileId).toBe(profile.id);
    // ...and only then may the socket join its own driver room.
    expect(await canJoinRoom(identity!, driverRoom(profile.id))).toBe(true);
  });

  it("unknown and blocked uids resolve to null (handshake rejected)", async () => {
    expect(await resolveSocketIdentity("no-such-uid")).toBeNull();

    const blocked = await user("DRIVER", { isBlocked: true });
    await prisma.driverProfile.create({
      data: { userId: blocked.id, isVerified: true },
    });
    expect(await resolveSocketIdentity(blocked.firebaseUid)).toBeNull();
  });
});
