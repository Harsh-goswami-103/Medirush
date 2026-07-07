# Phase 2 — Payments & Rx

Binding brief for Phase 2 agents. Extends `phase-0-conventions.md` + `phase-1-core-api.md`
(both still binding). Blueprint sections: §3.3 (order flow), §7.2 (endpoints), §9.3 (payments &
refunds), §9.7 (invoice), §10.1 (payment tampering), §13 (file storage), §14 (integrations).

**DoD (§23):** prepaid + Rx orders fully functional with money-safe tests green — webhook replay =
no double-processing; Rx-reject auto-refunds + restocks; invoice PDF fields complete.

## Overriding principle: everything third-party has a LOCAL STUB MODE

The operator supplies real Razorpay / R2 / Firebase keys only at deployment. Every integration
MUST work with NO real credentials in dev/test, using deterministic stubs, and switch to the real
service when its env vars are set (mirrors `core/config.ts`: third-party keys optional in dev/test,
required in production). Same code path, config-selected. This is not optional — the full prepaid +
Rx + invoice flow must be testable and runnable locally today.

- **Razorpay** (`core/razorpay.ts`): when `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` are set → real
  SDK (`razorpay` pkg). Else → STUB: `createOrder` returns `{ id: "order_" + cuid, amount, currency }`;
  `createRefund` returns `{ id: "rfnd_" + cuid, status: "processed" }`. Webhook signature ALWAYS uses
  HMAC-SHA256 over the raw body with `config.RAZORPAY_WEBHOOK_SECRET ?? "dev-webhook-secret"` — so
  tests can locally sign a payload and exercise the real verification path in both modes.
- **R2 storage** (`core/storage.ts`): when `R2_ACCOUNT_ID` + keys set → S3 SDK against R2. Else →
  STUB: write bytes under `apps/api/.storage/<bucket>/<key>` (gitignored) and return for presign a
  syntactically valid URL `https://r2.local.invalid/<bucket>/<key>?stub=1&exp=<ts>` (z.url()-valid,
  never dereferenced in tests). Keys are ALWAYS server-generated.
- **Firebase**: already stubbed by the P1 dev-token path — Rx upload just needs an authed customer.

Add `apps/api/.storage/` to root `.gitignore` (integrator will confirm).

## Scope decisions (adjudicated — do not relitigate)

1. **Prepaid create**: `POST /v1/orders` with `paymentMethod:"PREPAID"` now creates the order at
   status **PENDING_PAYMENT** (paymentStatus PENDING), reserves stock (same §9.4 conditional
   UPDATE as COD — reservation happens at create for BOTH methods, §9.4), creates a Razorpay order,
   writes a `Payment` row (rzpOrderId), enqueues a **payment-timeout job (15 min)**, and returns
   `{ order, razorpay: { rzpOrderId, rzpKeyId, amountPaise, currency:"INR" } }`. Rx flag is computed
   but the RX_REVIEW gate applies only AFTER payment (order stays PENDING_PAYMENT until captured).
2. **Webhook** `POST /v1/webhooks/razorpay` (public, signature-gated, rate-limit-exempt, RAW body):
   verify HMAC signature (`x-razorpay-signature`); insert `PaymentEvent(eventId PK)` FIRST as the
   idempotency gate (duplicate eventId → 200 + skip); then handle:
   - `payment.captured` → PENDING_PAYMENT order → PLACED (or RX_REVIEW if requiresRx); paymentStatus
     PAID; set Payment.rzpPaymentId; cancel the payment-timeout job; emit socket + ops new-order.
   - `payment.failed` → PENDING_PAYMENT → CANCELLED + release stock (restockOrder) + event.
   - `refund.processed` → paymentStatus REFUND_INITIATED → REFUNDED; set Payment.refundId if absent.
   Unknown event types → 200 + ignore. Always 200 on success (Razorpay retries on non-2xx).
3. **Payment-timeout job** (`jobs/paymentTimeout.ts`): 15 min after create; if the order is still
   PENDING_PAYMENT → CANCELLED + release stock + event (actor SYSTEM). No-op if already moved.
   Enqueue is best-effort AFTER the create TX commits (pg-boss uses its own connection; strict
   atomic enqueue is a documented Phase-scale item — the stuck-order watchdog + this job together
   cover orphans). Register the worker in `core/jobs.ts`.
4. **Refunds** (`initiateRefund(orderId)` in `modules/payments/service.ts`): for a PREPAID order
   whose paymentStatus is PAID (or COD → no-op), call `razorpay.createRefund` (EXTERNAL — never
   inside a DB transaction, §14) then set paymentStatus REFUND_INITIATED + Payment.refundId + an
   OrderEvent/AuditLog note. The `refund.processed` webhook later flips REFUNDED. Idempotent: if
   already REFUND_INITIATED/REFUNDED, no-op. Called by customer/ops cancel of a paid prepaid order
   AND by Rx-reject.
5. **Rx upload** `POST /v1/orders/:id/prescriptions` (multipart, customer, own order): single `file`
   part, ≤ RX_MAX_UPLOAD_BYTES (5MB), MIME + **magic-byte** allowlist (jpeg/png/pdf); images
   re-encoded via sharp (strips EXIF/GPS); PDFs passed through after header check. Store to R2
   private under `rx/{orderId}/{cuid}.{ext}` (server-generated). Create a `Prescription` row
   (status PENDING). Allowed only while the order still needs Rx (requiresRx, rxStatus PENDING/
   REJECTED, not yet DELIVERED/CANCELLED).
6. **Rx review** `POST /v1/ops/orders/:id/rx-review` (INVENTORY/ADMIN): body `RxReviewBodySchema`
   (APPROVED needs nothing extra; REJECTED requires a note — contract enforces). APPROVED → set the
   latest Prescription + order rxStatus APPROVED (order stays RX_REVIEW; ops can now start-packing —
   the P1 gate already checks rxStatus APPROVED); capture patientName/doctorName for the H1 register.
   REJECTED → order CANCELLED + restockOrder + `initiateRefund` (prepaid) + rxStatus REJECTED +
   Prescription REJECTED + reviewNote + event; emit. The ops detail already exposes prescriptions;
   ops file access is a short-TTL presigned GET (`OpsPrescriptionSchema.fileUrl`), real in prod,
   stub URL in dev.
7. **Invoice** (`jobs/invoicePdf.ts` + `modules/invoices/service.ts`): enqueued after an order
   reaches DELIVERED (from the deliver path). Generates an **FY-sequential invoice number** from a
   counter row (see schema below) inside a transaction with a row lock, renders a PDF with pdfkit
   (store name/address, **GSTIN, Drug License No, Pharmacist name + Reg No** from StoreConfig, HSN
   per line, GST-inclusive back-computed CGST/SGST split equally per §9.2, batch numbers for Rx
   items from ItemBatchAlloc), uploads to R2 private `inv/{fy}/{invoiceNo}.pdf`, sets
   `Order.invoiceNo` + `Order.invoiceKey`. `GET /v1/orders/:id/invoice` (customer, own) →
   `{ url, expiresInSec }` presigned (409/404 if not yet generated).
8. **NOT in Phase 2**: RazorpayX payouts (Phase 5 uses the P1 wallet), notification fan-out job
   (Phase 6), Resend email. Admin refund UI (Phase 3).

## Schema addition (additive — integrator runs the migration)

Add to `prisma/schema.prisma` (agent I owns this edit):
```prisma
model InvoiceCounter {
  fy   String @id      // "25-26"
  next Int    @default(1)
}
```
Invoice number format: `MR/{fy}/{next padded 6}` e.g. `MR/25-26/000123`. FY starts April 1 (IST):
Apr 2025–Mar 2026 = "25-26". Increment atomically: inside a tx, `upsert` then read-modify-write
under a `SELECT … FOR UPDATE` on the row (or an atomic `UPDATE … SET next = next + 1 RETURNING`).
Never reuse a number even for cancelled orders (GST rule — invoices are only for DELIVERED here).

## File ownership (disjoint — single writer per file)

| Agent | Owns (NEW) | Owns (EXTEND — sole writer) | Tests |
|---|---|---|---|
| **P payments** | `core/razorpay.ts`, `modules/payments/{service,webhook,routes}.ts`, `jobs/paymentTimeout.ts` | `modules/orders/service.ts` (PREPAID branch in createOrder; wire `initiateRefund` into `cancelOrder` for paid prepaid) | `test/payments.int.test.ts` |
| **R rx+storage** | `core/storage.ts`, `core/rxProcessing.ts`, `modules/prescriptions/routes.ts` | `modules/orders/opsService.ts` + `opsRoutes.ts` (add rx-review), `src/app.ts` (register @fastify/multipart) | `test/prescriptions.int.test.ts`, `test/rx-review.int.test.ts` |
| **I invoice** | `core/pdf.ts`, `modules/invoices/service.ts`, `jobs/invoicePdf.ts` | `modules/drivers/routes.ts` (enqueue invoice after deliver commit), `modules/orders/routes.ts` (GET /invoice), `prisma/schema.prisma` (InvoiceCounter), `core/jobs.ts` (register payment-timeout + invoice workers) | `test/invoice.int.test.ts` |

`src/modules/v1.ts` is already updated by the integrator and imports **`paymentRoutes`**
(`modules/payments/routes.ts`) and **`prescriptionRoutes`** (`modules/prescriptions/routes.ts`) —
export EXACTLY those names.

## Pinned cross-agent interfaces (match these signatures exactly)

```ts
// core/razorpay.ts (P) — consumed by payments/service + tests
createRazorpayOrder(amountPaise: number, receipt: string): Promise<{ id: string; amount: number; currency: "INR" }>
createRazorpayRefund(paymentId: string, amountPaise: number): Promise<{ id: string; status: string }>
verifyWebhookSignature(rawBody: string, signature: string): boolean   // HMAC-SHA256, dev secret fallback
razorpayKeyId(): string                                               // stub returns "rzp_test_stub"

// modules/payments/service.ts (P) — consumed by R (rx-reject) and orders/service (cancel)
initiateRefund(orderId: string): Promise<void>                        // external refund call OUTSIDE any tx, then REFUND_INITIATED

// jobs/paymentTimeout.ts (P) — consumed by I (jobs.ts) and orders/service (enqueue)
enqueuePaymentTimeout(orderId: string): Promise<void>                 // boss.send delay 15m
registerPaymentTimeout(boss: PgBoss): Promise<void>                   // createQueue + work

// core/storage.ts (R) — consumed by R (rx) and I (invoice)
putPrivateObject(key: string, body: Buffer, contentType: string): Promise<void>
presignPrivateGet(key: string, ttlSec: number): Promise<string>      // z.url()-valid

// core/rxProcessing.ts (R)
validateAndNormalizeUpload(buf: Buffer, mime: string): Promise<{ ext: "jpg"|"png"|"pdf"; body: Buffer; contentType: string }>  // magic-byte check + sharp re-encode; throws AppError VALIDATION_ERROR on bad type/oversize

// jobs/invoicePdf.ts (I)
enqueueInvoicePdf(orderId: string): Promise<void>
registerInvoicePdf(boss: PgBoss): Promise<void>

// modules/orders/service.ts (P1, exists) — consumed by P/R
restockOrder(tx: Prisma.TransactionClient, orderId: string): Promise<void>
```

## Conventions carried from P1

Zod type provider + `@medrush/contracts` schemas on every route (never hand-rolled); do NOT edit
`packages/contracts` — report mismatches. `assertTransition` INSIDE the tx for every status change;
exactly one OrderEvent per transition; socket emits AFTER commit; money integer paise; external
calls (Razorpay/R2) NEVER inside a DB transaction (enqueue/call out, §14). `no-store` on all new
authed routes; the webhook route is public + rate-limit-exempt. Error codes from the pinned list
(`PAYMENT_FAILED`, `RX_REQUIRED`, `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, …). AuditLog on
rx-review + refund (sensitive actions).

## Tests (money-safe is the bar)

Integration tests use the P1 harness (`test/helpers/{db,factories,auth}`) against
`postgresql://postgres@localhost:5433/medrush_test`. Required coverage:
- **payments**: prepaid create → PENDING_PAYMENT + razorpay block + Payment row + stock reserved;
  a locally-signed `payment.captured` webhook → PLACED (or RX_REVIEW), paymentStatus PAID, timeout
  job cancelled; **replay the same eventId → 200, single processing (no double transition)**; bad
  signature → 401/400 no state change; `payment.failed` → CANCELLED + stock restored; payment-timeout
  handler on a still-PENDING order → CANCELLED + restock, and no-op once PLACED.
- **rx**: upload a fake PNG (valid magic bytes) → Prescription PENDING + stored; oversize/bad-MIME →
  422; upload to another user's order → 404/403; rx-review APPROVE → rxStatus APPROVED, start-packing
  now succeeds; rx-review REJECT (prepaid paid order) → CANCELLED + stock restored + refund initiated
  (paymentStatus REFUND_INITIATED); reject without note → 422 (contract).
- **invoice**: run the invoice job for a DELIVERED order → Order.invoiceNo matches `MR/\d\d-\d\d/\d{6}`,
  invoiceKey set, PDF bytes start with `%PDF`; FY counter increments across two invoices (no reuse);
  GET /invoice → presigned url + expiresInSec; GET before generation → 409/404.

## Notes for agents

- Node 20 local; `crypto` for HMAC (`createHmac("sha256", secret).update(raw).digest("hex")`).
- Fastify raw body for the webhook: register a scoped content-type parser on the payments plugin
  that keeps the raw string (e.g. `addContentTypeParser("application/json", { parseAs: "string" })`
  within the plugin, then `JSON.parse` after verifying) — do NOT globally disable JSON parsing.
- Do NOT run pnpm install/build/test or touch git. Report a JSON manifest
  `{"files":[...],"notes":[...],"contractMismatches":[...]}`.
