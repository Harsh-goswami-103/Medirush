# Summary

<!-- What does this PR do, and why? Link the phase brief / issue. -->

## Checklist (BLUEPRINT §21.2 — non-negotiable)

- [ ] **Contracts updated?** New/changed payloads, enums, events, or error codes are reflected in `@medrush/contracts` (single source of truth) — or N/A.
- [ ] **Migration expand-safe?** Any Prisma migration follows expand → deploy → contract; no destructive change ships in the same release as the code that stops using it — or N/A.
- [ ] **Tests for domain logic?** State machine / pricing / stock / ledger / coupon changes come with unit or integration tests — or N/A.
- [ ] **Audit-log for sensitive action?** New sensitive mutations (money, stock, roles, settings, Rx decisions) write an `AuditLog` entry — or N/A.
- [ ] **docs/BLUEPRINT drift?** Behavior that diverges from `docs/BLUEPRINT.md` is either reverted or the divergence is documented (ADR / blueprint note) — or N/A.

## Review ritual (solo + AI, §21.2)

- [ ] **Self-review done** — I read the full diff line by line before requesting review.
- [ ] **AI review pass done** — Claude Code review with the fixed prompt: state-machine legality, TX boundaries around stock/wallet, Zod coverage on new routes, authz on new endpoints, migration safety. Generated code does not merge without this pass.

## Notes for reviewer

<!-- Risky areas, follow-ups, anything intentionally out of scope. -->
