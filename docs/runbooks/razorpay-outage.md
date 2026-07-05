# Runbook — Razorpay Outage

**Source:** BLUEPRINT §14 (failure behavior), §15 (alert rules), §7/§9 (payment lifecycle).

## Purpose

Keep the store selling (COD path) and money-safe while Razorpay (checkout, Orders API, or webhooks) is degraded or down, then reconcile cleanly after recovery.

## Trigger

Any of:
- Better Stack / Sentry alert: payment-timeout spike, or webhook signature failures >3/hr (§15).
- Checkout errors on Razorpay order creation (API 5xx from Razorpay).
- Razorpay status page incident, or customer reports of payment sheet failing.

## Steps

1. **Confirm scope.** Check Razorpay status page + Sentry errors: is it checkout (client), Orders API (order creation), or webhooks (capture confirmation) that is failing?
2. **Verify COD still works** — by design payment-down never blocks COD (§14): place a small COD test order. COD remains the functional fallback; do NOT close the store for a payments-only outage.
3. **Let the safety nets run.** Stuck `PENDING_PAYMENT` orders are auto-cancelled (stock released) by the 15-minute payment-timeout job — no manual cancellation needed. Confirm the job is firing (job dashboard / logs).
4. **If only webhooks are down** (payments captured but confirmations missing): do nothing destructive — Razorpay retries webhooks. Orders will flip to PLACED/RX_REVIEW when delivery resumes. If the timeout job cancels an order whose payment actually captured, the reconcile step (7) catches it → refund.
5. **Optionally steer customers to COD** (banner / disable prepaid at checkout). _Fill during Phase 7 drill: the exact `AppSetting` flag name and ops UI location for disabling prepaid, plus banner copy._
6. **Communicate**: ops board note + (if long) status message to customers. _Fill during Phase 7 drill: comms template._
7. **After recovery — reconcile.** Compare Razorpay dashboard captures vs orders for the outage window: (a) captured payment + cancelled order → issue refund via Razorpay; (b) captured payment + order still pending → verify webhook replay processed it (idempotent via `PaymentEvent` PK, replay = no double-processing); (c) log every manual fix in AuditLog.
8. **Close out**: re-enable prepaid if disabled, confirm webhook signature failures back to 0, note incident timeline in the drill log below.

## Verification

- [ ] COD checkout functional throughout.
- [ ] No order stuck in `PENDING_PAYMENT` older than 15 min.
- [ ] Post-recovery reconcile complete; refunds initiated where owed.

| Date | Duration | Impact | Notes |
|---|---|---|---|
| _fill during Phase 7 drill_ | | | |
