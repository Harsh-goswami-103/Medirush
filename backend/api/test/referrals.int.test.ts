import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

/**
 * Referral programme (Batch 3): GET /v1/referrals summary + code generation,
 * POST /v1/referrals/apply attribution, and the post-DELIVERED reward hook.
 * Real Postgres.
 */

// Env must be set BEFORE the app is imported (config/logger parse eagerly).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_c6_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { maybeRewardReferral } = await import("../src/modules/referrals/service");
const { setupTestDb } = await import("./helpers/db");
const { appSettings, product, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;
type User = Awaited<ReturnType<typeof user>>;

const DAY_MS = 86_400_000;

const prisma = getPrisma();
let app: App;

function getSummary(headers: Record<string, string>) {
  return app.inject({ method: "GET", url: "/v1/referrals", headers });
}

function postApply(headers: Record<string, string>, code: string) {
  return app.inject({ method: "POST", url: "/v1/referrals/apply", headers, payload: { code } });
}

/** A CUSTOMER plus their auth headers. */
async function customer() {
  const row = await user("CUSTOMER");
  return { row, headers: authHeaders(row) };
}

/** Read (generating on first call) a user's shareable code through the API. */
async function codeOf(headers: Record<string, string>): Promise<string> {
  const res = await getSummary(headers);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.code as string;
}

async function order(userId: string, overrides: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  return prisma.order.create({
    data: {
      orderNo: `MR-TEST-${Math.random().toString(36).slice(2, 10)}`,
      userId,
      status: "DELIVERED",
      paymentMethod: "COD",
      paymentStatus: "COD_COLLECTED",
      addressSnapshot: { line1: "1 Test Road", pincode: "560001" } as Prisma.InputJsonValue,
      distanceM: 1000,
      itemsPaise: 30_000,
      deliveryPaise: 0,
      totalPaise: 30_000,
      deliveredAt: new Date(),
      ...overrides,
    },
  });
}

/** Referrer + referee already attributed to each other (referral PENDING). */
async function attributedPair() {
  const referrer = await customer();
  const referee = await customer();
  const code = await codeOf(referrer.headers);
  const applied = await postApply(referee.headers, code);
  expect(applied.statusCode, applied.body).toBe(200);
  return { referrer, referee, code };
}

beforeAll(async () => {
  // referralRoutes is registered by modules/v1.ts — registering it again here
  // would trip FST_ERR_DUPLICATED_ROUTE.
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
  await storeConfig(); // minOrder 9_900, delivery 2_000, free above 49_900
  await appSettings();
});

describe("GET /v1/referrals", () => {
  it("generates and persists a stable uppercase code on first read", async () => {
    const { row, headers } = await customer();
    expect(row.referralCode).toBeNull();

    const first = await getSummary(headers);
    expect(first.statusCode, first.body).toBe(200);
    const code = first.json().data.code as string;
    expect(code).toMatch(/^MR[A-Z0-9]{6}$/);
    expect(code).toBe(code.toUpperCase());
    expect(first.headers["cache-control"]).toBe("no-store");

    const persisted = await prisma.user.findUniqueOrThrow({ where: { id: row.id } });
    expect(persisted.referralCode).toBe(code);

    const second = await getSummary(headers);
    expect(second.json().data.code).toBe(code);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: row.id } }).then((u) => u.referralCode),
    ).toBe(code);
  });

  it("hands different users different codes", async () => {
    const a = await customer();
    const b = await customer();
    expect(await codeOf(a.headers)).not.toBe(await codeOf(b.headers));
  });

  it("empty summary carries the default economics", async () => {
    const { headers } = await customer();
    const body = (await getSummary(headers)).json().data;
    expect(body.signedUp).toBe(0);
    expect(body.rewarded).toBe(0);
    expect(body.rewardPaise).toBe(10_000);
    expect(body.refereeRewardPaise).toBe(5_000);
    expect(body.rewards).toEqual([]);
  });

  it("ops can tune both reward amounts through AppSetting", async () => {
    await appSettings({ referral_reward_paise: 20_000, referral_referee_reward_paise: 7_500 });
    const { headers } = await customer();
    const body = (await getSummary(headers)).json().data;
    expect(body.rewardPaise).toBe(20_000);
    expect(body.refereeRewardPaise).toBe(7_500);
  });

  it("ignores a non-integer flag value and falls back to the default", async () => {
    await appSettings({ referral_reward_paise: "lots" });
    const { headers } = await customer();
    expect((await getSummary(headers)).json().data.rewardPaise).toBe(10_000);
  });

  it("requires auth → 401 without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/referrals" });
    expect(res.statusCode, res.body).toBe(401);
  });

  it("never shows another user's reward coupons", async () => {
    const { referrer, referee } = await attributedPair();
    const stranger = await customer();

    const refereeRewards = (await getSummary(referee.headers)).json().data.rewards;
    expect(refereeRewards).toHaveLength(1);

    // The welcome coupon belongs to the referee alone.
    expect((await getSummary(referrer.headers)).json().data.rewards).toEqual([]);
    expect((await getSummary(stranger.headers)).json().data.rewards).toEqual([]);
    expect((await getSummary(stranger.headers)).json().data.signedUp).toBe(0);
  });
});

describe("POST /v1/referrals/apply", () => {
  it("attributes the caller and issues the welcome coupon", async () => {
    const referrer = await customer();
    const referee = await customer();
    const code = await codeOf(referrer.headers);

    const res = await postApply(referee.headers, code.toLowerCase());
    expect(res.statusCode, res.body).toBe(200);

    const referral = await prisma.referral.findUniqueOrThrow({ where: { refereeId: referee.row.id } });
    expect(referral.referrerId).toBe(referrer.row.id);
    expect(referral.code).toBe(code);
    expect(referral.status).toBe("PENDING");
    expect(referral.rewardCouponCode).toBeNull();
    expect(referral.rewardedAt).toBeNull();

    const coupons = await prisma.coupon.findMany({ where: { userId: referee.row.id } });
    expect(coupons).toHaveLength(1);
    const welcome = coupons[0]!;
    expect(welcome.code).toMatch(/^MR-[A-Z0-9]{8}$/);
    expect(welcome.kind).toBe("FLAT");
    expect(welcome.valuePaiseOrPct).toBe(5_000);
    expect(welcome.minOrderPaise).toBe(29_900);
    expect(welcome.perUserLimit).toBe(1);
    expect(welcome.isPublic).toBe(false);
    expect(welcome.isActive).toBe(true);
    const windowDays = Math.round((welcome.endsAt.getTime() - welcome.startsAt.getTime()) / DAY_MS);
    expect(windowDays).toBe(30);

    // The response is the caller's fresh summary, welcome coupon included.
    const data = res.json().data;
    expect(data.rewards).toHaveLength(1);
    expect(data.rewards[0]).toMatchObject({
      code: welcome.code,
      valuePaise: 5_000,
      minOrderPaise: 29_900,
      used: false,
    });
    expect(data.signedUp).toBe(0); // the referee referred nobody themselves

    const notes = await prisma.notification.findMany({ where: { userId: referee.row.id } });
    expect(notes.map((n) => n.type)).toContain("REFERRAL_WELCOME");
  });

  it("uses the tuned referee amount", async () => {
    await appSettings({ referral_referee_reward_paise: 7_500 });
    const { referee } = await attributedPair();
    const coupon = await prisma.coupon.findFirstOrThrow({ where: { userId: referee.row.id } });
    expect(coupon.valuePaiseOrPct).toBe(7_500);
  });

  it("unknown code → 404", async () => {
    const { headers } = await customer();
    const res = await postApply(headers, "MRZZZZZZ");
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(await prisma.referral.count()).toBe(0);
    expect(await prisma.coupon.count()).toBe(0);
  });

  it("own code → 422", async () => {
    const { headers } = await customer();
    const res = await postApply(headers, await codeOf(headers));
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(await prisma.referral.count()).toBe(0);
  });

  it("second apply on the same account → 409", async () => {
    const { referee } = await attributedPair();
    const other = await customer();

    const res = await postApply(referee.headers, await codeOf(other.headers));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
    expect(await prisma.referral.count()).toBe(1);
    expect(await prisma.coupon.count({ where: { userId: referee.row.id } })).toBe(1);
  });

  it("caller who already ordered → 422 (referrals are for new users)", async () => {
    const referrer = await customer();
    const referee = await customer();
    await order(referee.row.id, { status: "PLACED", paymentStatus: "COD_DUE", deliveredAt: null });

    const res = await postApply(referee.headers, await codeOf(referrer.headers));
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(await prisma.referral.count()).toBe(0);
    expect(await prisma.coupon.count()).toBe(0);
  });

  it("rejects a malformed body → 400", async () => {
    const { headers } = await customer();
    const res = await app.inject({
      method: "POST",
      url: "/v1/referrals/apply",
      headers,
      payload: { code: "ab" },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("requires auth → 401 without a token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/referrals/apply",
      payload: { code: "MRAAAAAA" },
    });
    expect(res.statusCode, res.body).toBe(401);
  });
});

describe("maybeRewardReferral", () => {
  it("pays the referrer once the referee's order is delivered — and only once", async () => {
    const { referrer, referee } = await attributedPair();
    await order(referee.row.id);

    await maybeRewardReferral(referee.row.id);
    await maybeRewardReferral(referee.row.id);

    const rewards = await prisma.coupon.findMany({ where: { userId: referrer.row.id } });
    expect(rewards).toHaveLength(1);
    const reward = rewards[0]!;
    expect(reward.valuePaiseOrPct).toBe(10_000);
    expect(reward.minOrderPaise).toBe(29_900);
    expect(reward.isPublic).toBe(false);
    expect(reward.perUserLimit).toBe(1);

    const referral = await prisma.referral.findUniqueOrThrow({ where: { refereeId: referee.row.id } });
    expect(referral.status).toBe("REWARDED");
    expect(referral.rewardCouponCode).toBe(reward.code);
    expect(referral.rewardedAt).not.toBeNull();

    const notes = await prisma.notification.findMany({ where: { userId: referrer.row.id } });
    expect(notes.filter((n) => n.type === "REFERRAL_REWARD")).toHaveLength(1);

    const summary = (await getSummary(referrer.headers)).json().data;
    expect(summary.signedUp).toBe(1);
    expect(summary.rewarded).toBe(1);
    expect(summary.rewards).toHaveLength(1);
    expect(summary.rewards[0].code).toBe(reward.code);
    expect(summary.rewards[0].used).toBe(false);
  });

  it("does nothing before any delivered order", async () => {
    const { referrer, referee } = await attributedPair();
    await order(referee.row.id, { status: "PLACED", paymentStatus: "COD_DUE", deliveredAt: null });

    await maybeRewardReferral(referee.row.id);

    expect(await prisma.coupon.count({ where: { userId: referrer.row.id } })).toBe(0);
    const referral = await prisma.referral.findUniqueOrThrow({ where: { refereeId: referee.row.id } });
    expect(referral.status).toBe("PENDING");

    const summary = (await getSummary(referrer.headers)).json().data;
    expect(summary.signedUp).toBe(1);
    expect(summary.rewarded).toBe(0);
  });

  it("is a no-op for a user with no referral, and never throws", async () => {
    const { row } = await customer();
    await order(row.id);
    await expect(maybeRewardReferral(row.id)).resolves.toBeUndefined();
    await expect(maybeRewardReferral("no-such-user")).resolves.toBeUndefined();
    expect(await prisma.coupon.count()).toBe(0);
  });

  it("marks a redeemed reward as used in the summary", async () => {
    const { referrer, referee } = await attributedPair();
    await order(referee.row.id);
    await maybeRewardReferral(referee.row.id);

    const reward = await prisma.coupon.findFirstOrThrow({ where: { userId: referrer.row.id } });
    const spent = await order(referrer.row.id, { couponCode: reward.code });
    await prisma.couponRedemption.create({
      data: { couponId: reward.id, userId: referrer.row.id, orderId: spent.id },
    });

    const summary = (await getSummary(referrer.headers)).json().data;
    expect(summary.rewards[0].used).toBe(true);
  });
});

describe("personal coupons stay personal", () => {
  it("are not listed on the public offers surface", async () => {
    const { referee } = await attributedPair();
    const welcome = await prisma.coupon.findFirstOrThrow({ where: { userId: referee.row.id } });

    const listed = await app.inject({ method: "GET", url: "/v1/coupons" });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().data).toEqual([]);

    // Even mis-flagged as public, a user-bound coupon never reaches the list.
    await prisma.coupon.update({ where: { id: welcome.id }, data: { isPublic: true } });
    const again = await app.inject({ method: "GET", url: "/v1/coupons" });
    expect(again.json().data).toEqual([]);
  });

  it("are redeemable only by their owner", async () => {
    const { referee } = await attributedPair();
    const welcome = await prisma.coupon.findFirstOrThrow({ where: { userId: referee.row.id } });

    const cartFor = async (u: User) => {
      const cart = await prisma.cart.create({ data: { userId: u.id } });
      const p = await product({ pricePaise: 30_000 });
      await prisma.cartItem.create({ data: { cartId: cart.id, productId: p.id, qty: 1 } });
    };
    await cartFor(referee.row);

    const stranger = await customer();
    await cartFor(stranger.row);

    const mine = await app.inject({
      method: "POST",
      url: "/v1/coupons/validate",
      headers: referee.headers,
      payload: { code: welcome.code },
    });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().data.discountPaise).toBe(5_000);

    const theirs = await app.inject({
      method: "POST",
      url: "/v1/coupons/validate",
      headers: stranger.headers,
      payload: { code: welcome.code },
    });
    expect(theirs.statusCode, theirs.body).toBe(422);
    expect(theirs.json().error.code).toBe("COUPON_INVALID");
  });
});
