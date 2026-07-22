import type { FastifyPluginAsync } from "fastify";
import { authRoutes } from "./auth/routes";
import { addressRoutes } from "./addresses/routes";
import { storeRoutes } from "./store/routes";
import { deviceRoutes } from "./devices/routes";
import { notificationRoutes } from "./notifications/routes";
import { catalogRoutes } from "./catalog/routes";
import { cartRoutes } from "./cart/routes";
import { couponRoutes } from "./coupons/routes";
import { orderRoutes } from "./orders/routes";
import { opsOrderRoutes } from "./orders/opsRoutes";
import { driverRoutes } from "./drivers/routes";
import { walletRoutes } from "./wallet/routes";
import { prescriptionRoutes } from "./prescriptions/routes";
import { paymentRoutes } from "./payments/routes";
import { opsInventoryRoutes } from "./inventory/opsRoutes";
import { adminAnalyticsRoutes } from "./admin/analyticsRoutes";
import { adminAuditRoutes } from "./admin/auditRoutes";
import { adminFleetRoutes } from "./admin/fleetRoutes";
import { adminMarketingRoutes } from "./admin/marketingRoutes";
import { opsAlertRoutes } from "./alerts/routes";
import { dispatchOpsRoutes } from "./dispatch/opsRoutes";
import { feedbackRoutes } from "./feedback/routes";
import { patientRoutes } from "./patients/routes";
import { preferenceRoutes } from "./preferences/routes";
import { referralRoutes } from "./referrals/routes";
import { refillRoutes } from "./refills/routes";
import { wishlistRoutes } from "./wishlist/routes";

/**
 * /v1 module root — registered with `{ prefix: "/v1" }` in app.ts.
 * Module plugins declare their own full sub-paths (e.g. /auth/sync, /ops/orders/:id).
 * Ownership: this file is maintained by the integrator; module agents export the
 * names imported above (see docs/phase-briefs/phase-1-core-api.md).
 */
export const v1Routes: FastifyPluginAsync = async (app) => {
  await app.register(authRoutes);
  await app.register(addressRoutes);
  await app.register(storeRoutes);
  await app.register(deviceRoutes);
  await app.register(notificationRoutes);
  await app.register(catalogRoutes);
  await app.register(cartRoutes);
  await app.register(orderRoutes);
  await app.register(opsOrderRoutes);
  await app.register(driverRoutes);
  await app.register(walletRoutes);
  // Phase 2
  await app.register(prescriptionRoutes);
  await app.register(paymentRoutes); // POST /v1/webhooks/razorpay (public, signature-gated)
  // Phase 3 — ops inventory management + admin panel
  await app.register(opsInventoryRoutes);
  await app.register(adminAnalyticsRoutes);
  await app.register(adminFleetRoutes);
  await app.register(adminMarketingRoutes);
  // Phase 7 — durable ops alerts + dispatch dead-end recovery
  await app.register(opsAlertRoutes);
  await app.register(dispatchOpsRoutes);
  // Phase 7 — audit-trail read side (DPDP erasure + admin action review)
  await app.register(adminAuditRoutes);
  // Feature-gap Batch 2 — customer offers surface + coupon apply-preview
  await app.register(couponRoutes);

  // Batch 3 — ratings/returns, dependent profiles, consent + erasure,
  // referrals, refill reminders, wishlist.
  await app.register(feedbackRoutes);
  await app.register(patientRoutes);
  await app.register(preferenceRoutes);
  await app.register(referralRoutes);
  await app.register(refillRoutes);
  await app.register(wishlistRoutes);
};
