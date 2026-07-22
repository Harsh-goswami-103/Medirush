import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Coupon } from "@prisma/client";
import type { ReferralReward, ReferralSummary } from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { getFlag } from "../../core/flags";
import { logger } from "../../core/logger";
import { emitOpsAlert } from "../../core/realtime";
import { notifyUser } from "../notifications/service";

/**
 * Referral programme (§17 v1.1). Both sides are paid as PERSONAL coupons
 * (`Coupon.userId`), so the reward spends through the exact validation and
 * redemption machinery checkout already runs — there is no second money path.
 *
 * - referee: welcome coupon at attribution time (POST /v1/referrals/apply)
 * - referrer: reward coupon once the referee's first order reaches DELIVERED
 *   (`maybeRewardReferral`, called post-commit by the delivery transition)
 */

const REFERRER_REWARD_FLAG = "referral_reward_paise";
const REFEREE_REWARD_FLAG = "referral_referee_reward_paise";
const DEFAULT_REFERRER_REWARD_PAISE = 10_000;
const DEFAULT_REFEREE_REWARD_PAISE = 5_000;

/** Fixed coupon shape for both sides of the programme. */
const REWARD_MIN_ORDER_PAISE = 29_900;
const REWARD_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/** Crockford-ish base32: no I/L/O/0/1, so a shared code is not misread. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_CODE_ATTEMPTS = 8;

const REFERRAL_STATUS_PENDING = "PENDING";
const REFERRAL_STATUS_REWARDED = "REWARDED";

function randomToken(length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

function isUniqueViolation(error: unknown, field: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) return target.includes(field);
  return typeof target === "string" && target.includes(field);
}

/** Flags are admin-written JSON — ignore anything that is not a positive integer. */
async function rewardPaise(flag: string, fallback: number): Promise<number> {
  const value = await getFlag<unknown>(flag, fallback);
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function referrerRewardPaise(): Promise<number> {
  return rewardPaise(REFERRER_REWARD_FLAG, DEFAULT_REFERRER_REWARD_PAISE);
}

export function refereeRewardPaise(): Promise<number> {
  return rewardPaise(REFEREE_REWARD_FLAG, DEFAULT_REFEREE_REWARD_PAISE);
}

function couponData(
  userId: string,
  code: string,
  valuePaise: number,
  description: string,
): Prisma.CouponUncheckedCreateInput {
  const now = new Date();
  return {
    code,
    kind: "FLAT",
    description,
    valuePaiseOrPct: valuePaise,
    minOrderPaise: REWARD_MIN_ORDER_PAISE,
    perUserLimit: 1,
    startsAt: now,
    endsAt: new Date(now.getTime() + REWARD_WINDOW_DAYS * DAY_MS),
    isActive: true,
    isPublic: false,
    userId,
  };
}

/** `MR-XXXXXXXX` — retried until the unique `Coupon.code` index accepts it. */
async function mintPersonalCoupon(
  userId: string,
  valuePaise: number,
  description: string,
): Promise<Coupon> {
  const prisma = getPrisma();
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.coupon.create({
        data: couponData(userId, `MR-${randomToken(8)}`, valuePaise, description),
      });
    } catch (error) {
      if (!isUniqueViolation(error, "code")) throw error;
    }
  }
  throw new AppError("INTERNAL", "Could not allocate a coupon code", 500);
}

/**
 * The caller's shareable code, generated and persisted on first read. The write
 * is conditional on `referralCode` still being null so two concurrent first
 * reads settle on one code rather than overwriting each other.
 */
export async function getOrCreateReferralCode(userId: string): Promise<string> {
  const prisma = getPrisma();
  const existing = await prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
  if (existing?.referralCode) return existing.referralCode;

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = `MR${randomToken(6)}`;
    try {
      const claimed = await prisma.user.updateMany({
        where: { id: userId, referralCode: null },
        data: { referralCode: code },
      });
      if (claimed.count === 1) return code;
    } catch (error) {
      if (!isUniqueViolation(error, "referralCode")) throw error;
      continue;
    }
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
    if (row?.referralCode) return row.referralCode;
  }
  throw new AppError("INTERNAL", "Could not allocate a referral code", 500);
}

function toReward(coupon: Coupon & { _count: { redemptions: number } }): ReferralReward {
  return {
    code: coupon.code,
    description: coupon.description,
    valuePaise: coupon.valuePaiseOrPct,
    minOrderPaise: coupon.minOrderPaise,
    endsAt: coupon.endsAt.toISOString(),
    used: coupon._count.redemptions > 0,
  };
}

/** Referral summary for the caller. Every read is scoped to `userId`. */
export async function getReferralSummary(userId: string): Promise<ReferralSummary> {
  const prisma = getPrisma();
  const code = await getOrCreateReferralCode(userId);

  const [signedUp, rewarded, coupons, rewardPaiseValue, refereePaiseValue] = await Promise.all([
    prisma.referral.count({ where: { referrerId: userId } }),
    prisma.referral.count({ where: { referrerId: userId, status: REFERRAL_STATUS_REWARDED } }),
    prisma.coupon.findMany({
      where: { userId },
      orderBy: { endsAt: "asc" },
      include: { _count: { select: { redemptions: true } } },
    }),
    referrerRewardPaise(),
    refereeRewardPaise(),
  ]);

  return {
    code,
    signedUp,
    rewarded,
    rewardPaise: rewardPaiseValue,
    refereeRewardPaise: refereePaiseValue,
    rewards: coupons.map(toReward),
  };
}

/**
 * Attribute `userId` as the referee of `rawCode`'s owner and issue the welcome
 * coupon. Referrals are for NEW accounts only, so any prior order disqualifies.
 */
export async function applyReferral(userId: string, rawCode: string): Promise<ReferralSummary> {
  const prisma = getPrisma();
  const code = rawCode.trim().toUpperCase();

  const referrer = await prisma.user.findUnique({
    where: { referralCode: code },
    select: { id: true },
  });
  if (!referrer) {
    throw new AppError("NOT_FOUND", "That referral code is not valid", 404);
  }
  if (referrer.id === userId) {
    throw new AppError("VALIDATION_ERROR", "You cannot use your own referral code", 422);
  }

  const alreadyReferred = await prisma.referral.findUnique({
    where: { refereeId: userId },
    select: { id: true },
  });
  if (alreadyReferred) {
    throw new AppError("CONFLICT", "A referral code has already been applied to this account", 409);
  }

  const priorOrder = await prisma.order.findFirst({ where: { userId }, select: { id: true } });
  if (priorOrder) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Referral codes can only be used before your first order",
      422,
    );
  }

  const valuePaise = await refereeRewardPaise();
  const description = `₹${Math.round(valuePaise / 100)} off your first order — welcome to MedRush`;

  let welcome: Coupon | null = null;
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const couponCode = `MR-${randomToken(8)}`;
    try {
      welcome = await prisma.$transaction(async (tx) => {
        await tx.referral.create({ data: { referrerId: referrer.id, refereeId: userId, code } });
        return tx.coupon.create({
          data: couponData(userId, couponCode, valuePaise, description),
        });
      });
      break;
    } catch (error) {
      // The referee-side unique index is the concurrency guard, not a retryable
      // code collision — a parallel apply already won.
      if (isUniqueViolation(error, "refereeId")) {
        throw new AppError(
          "CONFLICT",
          "A referral code has already been applied to this account",
          409,
        );
      }
      if (!isUniqueViolation(error, "code")) throw error;
    }
  }
  if (!welcome) {
    throw new AppError("INTERNAL", "Could not allocate a coupon code", 500);
  }

  await notifyUser({
    userId,
    type: "REFERRAL_WELCOME",
    title: "Your welcome offer is ready",
    body: `Use code ${welcome.code} for ${description}.`,
    data: { couponCode: welcome.code, valuePaise },
  });

  return getReferralSummary(userId);
}

/**
 * Post-commit hook for the DELIVERED transition: pays the referrer once the
 * referee has a delivered order. Exactly-once is enforced by the conditional
 * PENDING → REWARDED flip, so repeated calls mint at most one coupon. Never
 * throws — a reward is a side-channel to a committed delivery.
 */
export async function maybeRewardReferral(refereeId: string): Promise<void> {
  const prisma = getPrisma();
  let referralId: string | null = null;
  try {
    const referral = await prisma.referral.findFirst({
      where: { refereeId, status: REFERRAL_STATUS_PENDING },
      select: { id: true, referrerId: true },
    });
    if (!referral) return;
    referralId = referral.id;

    const delivered = await prisma.order.count({
      where: { userId: refereeId, status: "DELIVERED" },
    });
    if (delivered < 1) return;

    const claimed = await prisma.referral.updateMany({
      where: { id: referral.id, status: REFERRAL_STATUS_PENDING },
      data: { status: REFERRAL_STATUS_REWARDED, rewardedAt: new Date() },
    });
    if (claimed.count !== 1) return;

    const valuePaise = await referrerRewardPaise();
    const coupon = await mintPersonalCoupon(
      referral.referrerId,
      valuePaise,
      `₹${Math.round(valuePaise / 100)} referral reward — thanks for sharing MedRush`,
    );
    await prisma.referral.update({
      where: { id: referral.id },
      data: { rewardCouponCode: coupon.code },
    });

    await notifyUser({
      userId: referral.referrerId,
      type: "REFERRAL_REWARD",
      title: "You earned a referral reward",
      body: `Your friend's first order was delivered. Use code ${coupon.code} for ₹${Math.round(valuePaise / 100)} off.`,
      data: { couponCode: coupon.code, valuePaise },
    });
  } catch (error) {
    // The referral may already be flipped to REWARDED with no coupon minted —
    // ops has to issue it by hand, so this alert is the durable record.
    logger.error({ err: error, refereeId, referralId }, "maybeRewardReferral failed");
    emitOpsAlert(
      "referral_reward_failed",
      `Referral reward could not be issued for referee ${refereeId}`,
      referralId ?? refereeId,
      { refereeId, referralId },
    );
  }
}
