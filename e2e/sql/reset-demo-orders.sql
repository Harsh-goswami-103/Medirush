-- e2e setup: delete the demo customer's orders left behind by previous e2e
-- runs (everything except the seeded MR-250705-0001). Checkout enforces a
-- velocity gate of 3 orders/hour/account counted by Order.createdAt regardless
-- of status (backend/api/src/modules/orders/service.ts assertVelocity), so
-- without this cleanup back-to-back local runs 429 at checkout. Also puts the
-- reserved stock back so the cached counters keep matching batch truth:
--   - Product.stockQty is decremented at order creation and restored on cancel,
--   - Batch.qtyAvailable is decremented at packing (ItemBatchAlloc) and
--     restored on cancel (restockOrder) — so CANCELLED orders are already
--     restocked and only non-cancelled ones need reversing here.
-- Idempotent: the second run finds no doomed orders and changes nothing.
BEGIN;

CREATE TEMP TABLE doomed_orders ON COMMIT DROP AS
SELECT o."id", o."status"
FROM "Order" o
JOIN "User" u ON u."id" = o."userId"
WHERE u."firebaseUid" = 'seed-firebase-customer'
  AND o."orderNo" <> 'MR-250705-0001';

-- Restore packing allocations (aggregate first: UPDATE … FROM applies at most
-- one join row per target, so per-batch sums must be precomputed).
UPDATE "Batch" b
SET "qtyAvailable" = b."qtyAvailable" + agg."qty"
FROM (
  SELECT a."batchId", SUM(a."qty") AS "qty"
  FROM "ItemBatchAlloc" a
  JOIN "OrderItem" oi ON oi."id" = a."orderItemId"
  JOIN doomed_orders d ON d."id" = oi."orderId"
  WHERE d."status" <> 'CANCELLED'
  GROUP BY a."batchId"
) agg
WHERE b."id" = agg."batchId";

-- Restore the order-time stock reservation.
UPDATE "Product" p
SET "stockQty" = p."stockQty" + agg."qty"
FROM (
  SELECT oi."productId", SUM(oi."qty") AS "qty"
  FROM "OrderItem" oi
  JOIN doomed_orders d ON d."id" = oi."orderId"
  WHERE d."status" <> 'CANCELLED'
  GROUP BY oi."productId"
) agg
WHERE p."id" = agg."productId";

-- Children first (no ON DELETE CASCADE in the schema), then the orders.
DELETE FROM "ItemBatchAlloc" a
USING "OrderItem" oi
WHERE a."orderItemId" = oi."id"
  AND oi."orderId" IN (SELECT "id" FROM doomed_orders);
DELETE FROM "OrderEvent"       WHERE "orderId"    IN (SELECT "id" FROM doomed_orders);
DELETE FROM "Prescription"     WHERE "orderId"    IN (SELECT "id" FROM doomed_orders);
DELETE FROM "DeliveryOffer"    WHERE "orderId"    IN (SELECT "id" FROM doomed_orders);
DELETE FROM "Delivery"         WHERE "orderId"    IN (SELECT "id" FROM doomed_orders);
DELETE FROM "Payment"          WHERE "orderId"    IN (SELECT "id" FROM doomed_orders);
DELETE FROM "CouponRedemption" WHERE "orderId"    IN (SELECT "id" FROM doomed_orders);
DELETE FROM "StockAdjustment"  WHERE "refOrderId" IN (SELECT "id" FROM doomed_orders);
DELETE FROM "OrderItem"        WHERE "orderId"    IN (SELECT "id" FROM doomed_orders);
DELETE FROM "Order"            WHERE "id"         IN (SELECT "id" FROM doomed_orders);

COMMIT;
