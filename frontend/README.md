# frontend/

All client-facing apps live here (the backend API is in [`../backend/`](../backend)).
Each is its own workspace package; all share the frozen type contracts in
[`../packages/contracts`](../packages/contracts) plus `../packages/ui` and `../packages/config`.

| App | Stack | Phase | Deploy |
|---|---|---|---|
| `ops/` | Next.js 15 (App Router), role-gated **Ops + Admin** panel | **Phase 3** | Vercel — `ops.medrush.in` |
| `web/` | Next.js 15 customer PWA | Phase 4 | Vercel — `medrush.in` |
| `driver/` | Expo (expo-router) driver app | Phase 5 | Play Store / EAS |

> Clients never hand-write API types — they import from `@medrush/contracts`.
> A breaking change there fails typecheck in every app (the contract-freeze workflow).
