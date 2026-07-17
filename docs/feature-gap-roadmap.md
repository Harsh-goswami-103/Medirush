<!-- Generated 2026-07-17 by a 9-auditor feature-gap workflow (wf_b38b932a-171). 109 raw findings → synthesized roadmap. -->
<!-- PROGRESS 2026-07-17: Batch 1 BUILT + verified (incl. fixing the broken pg_trgm search — word_similarity).
     Batch 2 BUILT + verified: coupon preview + /offers, filters+sort, substitutes, back-in-stock alerts,
     delivery note/contactless (customer→ops→driver), refund visibility. Deferred from Batch 2: rider tip
     (wallet-ledger money flow), PDP medical-info columns, customer Rx surfacing, notification prefs,
     account deletion, ratings/returns/welcome offer. Batch 3 unchanged (needs product decisions). -->


# MedRush Customer PWA — Feature-Gap Roadmap

## 1. Executive summary

The audit surfaced 109 findings that collapse into ~55 distinct gaps clustered around three themes: **(a) missing discovery & merchandising** (banners, offers, featured/collections, filters, sort, substitutes, symptom browse); **(b) missing retention loops** (reorder, refill reminders, ratings, wishlist, referral, web push, loyalty); and **(c) shipped-but-silent v1 promises** — several ✅-marked blueprint items (reorder shortcut, free-delivery progress bar, min-order nudge in cart, map-pin address, web push, PWA install prompt, i18n) are absent or half-wired in code. The single most important gaps are the **v1 launch commitments that don't actually exist yet** (reorder, cart nudges, web push, coupon preview, blocking Rx flow) and the **pharmacy-defining retention features** (refill reminders, reorder, prescription locker) that make a medicine app worth reopening. Notably, a large share of high-value items need **zero backend work** — the endpoints already exist and the UI simply discards the data (category images, cursor pagination, category+search combine, refund fields, order status filters, free-delivery threshold, `maxPerOrder`, driver photo path).

## 2. Ranked gap table (deduplicated)

Sorted by value (high→low), then lowest effort first. Duplicate findings merged (e.g. "reorder" reported 4×, "refill reminders" 3×, "web push" 2×).

| Feature | Value | Effort | Backend? | Blueprint ref | Why it matters |
|---|---|---|---|---|---|
| Free-delivery progress bar + min-order nudge in cart | High | S | No | §17 v1 | ✅-promised v1 cart nudge; threshold already on the wire, below-min carts hit a dead end |
| Product grid pagination / infinite scroll | High | S | No | industry-std | Browsing hard-capped at 50 products; cursor plumbing already exists |
| Reorder / "Order again" (home rail + orders list + detail) | High | M | No | §17 v1 Home | ✅-promised, absent; repeat purchase is the core pharmacy loop |
| Coupon apply + live discount preview at checkout | High | M | Yes | §17 v1 | Customer pays without ever seeing the discount; blind code only fails at POST |
| Customer offers/deals page + coupon discovery | High | M | Yes | industry-std | Coupons are admin-only; users must know the code blind |
| Web push (FCM/VAPID) + permission priming | High | M | No | §17 v1 | ✅-promised; backend send path ready, frontend never registers a token |
| Product filters (price/brand/Rx/in-stock/discount) | High | M | Yes | industry-std | Filterable columns exist but are unreachable; table-stakes for any catalog |
| Sort control (price/discount/popularity/name) | High | M | Yes | industry-std | No sort at all; every peer ships it |
| Autocomplete / typeahead suggestions | High | M | No | industry-std | Search is a raw debounced input; trgm search already supports suggest |
| Generic substitutes / cheaper-alternative rail | High | M | Yes | §17 v1.1 | Composition/salt data exists; core value prop for price-sensitive med buyers |
| Delivery instructions / note to rider | High | M | Yes | industry-std | Standard everywhere; drop-off guidance for doorstep meds |
| Map pin + Ola autocomplete for address entry | High | L | No* | §17 v1 | ✅-promised; users type raw lat/lng today ("coords come from map in production") |
| Standalone "upload Rx & get callback/quote" flow | High | L | Yes | industry-std | The lead acquisition flow for every med app; only order-attached upload exists |
| Prescription locker (reusable saved Rx) | High | L | Yes | industry-std | Chronic patients re-upload every order; Rx is order-locked (no userId) |
| Refill reminders for repeat medicines | High | L | Yes | §17 v1.1 | §23's #2 post-launch item; the retention lever for a pharmacy |
| Return / report-an-issue for delivered orders | High | L | Yes | §18.3 | DELIVERED orders dead-end at invoice+WhatsApp; no damaged/wrong/missing path |
| Product ratings & reviews | High | L | Yes | §17 v1.1 | No social proof on PDP; verified-purchase reviews drive conversion |
| Referral program | High | L | Yes | §17 v1.1 | Cheap acquisition loop; needs reward-economics decision |
| First-order / welcome incentive | High | M | Yes | industry-std | Standard acquisition offer; no signup-grant hook exists |
| Bilingual EN/HI i18n framework | High | L | No | §20.1 | Mandated "from day one"; all copy hardcoded English, no i18n lib |
| Family / dependent patient profiles | High | L | Yes | industry-std | "Who is this for?" — improves H1-register accuracy; peers all support it |
| In-app Help/FAQ center + raise-a-ticket/grievance | High | M | Partial | industry-std | Only a WhatsApp deep-link; IT-rules grievance redressal has no in-app channel |
| Set default address (choose default) | High | S | No | §17 Address | Backend clears defaults in a TX already; UI exposes no "set default" |
| Out-of-stock "Notify me when back in stock" | High | M | Yes | industry-std | OOS is a dead-end span; notifications infra already exists |
| Dosage/uses/side-effects/storage medical info on PDP | High | M | Yes | industry-std | PDP has one freeform blob; med apps show structured safety sections |
| Category tiles use imageUrl (visual grid) | Med | S | No | industry-std | imageUrl is fetched and discarded; text-only chips |
| Recently viewed products rail | Med | S | No | industry-std | Client-only localStorage rail; standard home surface |
| Recent search history | Med | S | No | industry-std | Nothing persists past searches; client-only |
| Search within a selected category | Med | S | No | industry-std | Backend supports q+category; UI makes them mutually exclusive |
| No-results recovery (did-you-mean, popular, Rx CTA) | Med | S | No | industry-std | Zero-results is a dead end; trgm relax re-query is trivial |
| Related / similar products on PDP | Med | S | No | industry-std | All data present (categoryId + list endpoint); UI-only |
| Product image gallery/carousel | Med | S | No | §17 v1 | `images[]` array exists; PDP shows only image[0] |
| Low-stock urgency ("Only N left") | Med | S | Yes | industry-std | Only inStock bool exposed; needs privacy-safe lowStock flag |
| Per-order qty-cap messaging | Med | S | No | §17 v1 | Cap silently greys the + button; `maxPerOrder` already in contract |
| Rx-required explanatory banner on PDP | Med | S | No | industry-std | Only a tiny badge; reduces checkout drop-off |
| Share product (Web Share API) | Med | S | No | industry-std | WhatsApp-forwarding meds is common in India; URL already shareable |
| Order history status tabs + load-more | Med | S | No | industry-std | Backend has status filter + cursor; UI shows only first 20 |
| Manufacturer / marketer info on PDP | Med | S | Yes | industry-std | Only `brand`; peers show marketer/manufacturer |
| Refund-status detail (amount/ETA/UTR) | Med | M | Yes | §17 v1 | refundId stored but never exposed; only a badge shows |
| OOS/unavailable item handling on cart line | Med | S | No | §17 v1 | OOS line still looks purchasable; validate endpoint exists |
| Delivery ETA at checkout | Med | S | No | industry-std | 40-min is the core promise but no ETA shown; distanceM available |
| Customer view/download own uploaded Rx | Med | S | Yes | industry-std | Customer can never confirm what they submitted; ops-only presign today |
| Support click-to-call (tel:) | Med | S | No | §17 Support | §17 promises WhatsApp + call; only WhatsApp wired |
| Cross-order "My Prescriptions" status view | Med | M | Yes | §17 v1 | Rx status only visible per-order; no aggregate view |
| Doctor/patient capture at Rx upload | Med | M | Yes | industry-std | Customer never asked who/which doctor; feeds H1 register |
| Resubmit corrected Rx instead of hard-cancel | Med | M | Yes | industry-std | A blurry photo kills the whole order; re-upload branch unreachable |
| Blocking Rx upload before order create (flow fix) | Med | M | Yes | §18.1 | Deviates from blueprint; risks orders stranded in RX_REVIEW with no Rx |
| Post-delivery order & delivery rating prompt | Med | M | Yes | §17 v1.1 | No feedback capture; feeds driver stats |
| Notification preference toggles | Med | M | Yes | industry-std | Read-only center; TRAI consent relevance (promo vs transactional) |
| Customer wallet / refund-to-wallet / store credit | Med | L | Yes | industry-std | Wallet is driver-only; instant-refund + retention lever |
| Self-service account deletion | Med | M | Yes | industry-std | Google Play + DPDP right-to-erasure requirement; only Sign out exists |
| Loading skeletons (replace spinners) | Med | M | No | §20.4 | Mandated CLS≈0; spinners cause layout shift everywhere |
| In-app offline banner + cached view | Med | M | No | §20.4 | No online/offline detection; only static offline.html |
| aria-live on live order status changes | Med | S | No | §20.6 | Screen-reader users get no announcement on status transitions |
| First-run onboarding / location capture | Med | M | No | industry-std | Users fill carts before learning they're out of radius |
| Seasonal / curated collections | Med | L | Yes | industry-std | No cross-category merchandising sets |
| Personalized "For You" recommendations | Med | L | Yes | industry-std | Identical grid for every user |
| Subscriptions / auto-refill orders | Med | L | Yes | industry-std | Core chronic-med retention; larger than reminders |
| Trending / popular searches | Med | M | Yes | industry-std | Empty search box shows nothing to tap |
| Save for later (park cart item) | Med | M | Yes | industry-std | Remove is destructive; merge with wishlist |
| Wishlist / favourites | Med | M | Yes | §17 v1.1 | No save/heart control anywhere |
| Frequently bought together | Med | L | Yes | industry-std | Needs co-purchase pipeline |
| Pack-size / variant selection on one PDP | Med | L | Yes | industry-std | Variants are unrelated products today |
| Cart-abandonment nudges | Med | M | Yes | industry-std | Server-synced carts detectable; no re-engagement job |
| Health records / saved-Rx library | Med | L | Yes | industry-std | Overlaps prescription locker |
| Featured / best-seller sections | High | M | Yes | industry-std | Single undifferentiated grid; velocity already computed for ops |
| Category-wise home rails + category landing | Med | M | No | industry-std | Chips re-filter one grid; no /c/[slug] |
| Tip for delivery partner | Med | M | Yes | industry-std | Standard rider tip; credits driver wallet |
| Contactless delivery toggle | Med | S | Yes | industry-std | Standard for prepaid meds |
| Symptom / "shop by health concern" browse | High | L | Yes | industry-std | Prominent med-app discovery surface; no condition tagging |
| Shareable live-tracking link | Low | M | Yes | industry-std | Auth-gated track URL unusable by family |
| Driver photo on track/driver card | Low | M | Yes | §18.1 | §18.1 promises photo; only name/vehicle shown |
| Structured cancellation-reason chips | Low | S | No | industry-std | Free-text only; chips yield analyzable data |
| Cart upsell rail | Low | M | No | industry-std | Reuse category products |
| PWA install prompt after first delivery | Med | S | No | §20.5 | ✅-promised; no beforeinstallprompt capture |
| Visible focus rings | Med | S | No | §20.6 | WCAG 2.4.7 fail; search input actively removes indicator |
| prefers-reduced-motion support | Low | S | No | §20.2 | Mandated; no handling |
| EmptyState illustration + CTA | Low | S | No | §20.4 | Text-only dashed box; no CTA to recover |
| Inter/Noto Devanagari webfonts via next/font | Low | S | No | §11 | Declared in Tailwind but never loaded; not Devanagari-safe |
| DOB/gender on profile | Low | S | Yes | industry-std | Age-gated meds benefit; fold into patient profiles |
| Language/locale toggle | Low | M | No | §20.1 | Depends on i18n framework |
| Delivery slot / schedule-later | Low | M | Yes | industry-std | Defer unless refill roadmap |
| Saved payment methods | Low | M | Yes | industry-std | Razorpay sheet already remembers |
| Gift order option | Low | M | Yes | industry-std | Weak fit for medicine — skip |

\* Map pin needs a client SDK/key; a thin key-proxy endpoint is advisable but not strictly required.

## 3. Recommended build batches

### Batch 1 — Quick wins (high value, S/M, NO new backend)

Buildable on existing endpoints immediately. These reclaim ✅-promised v1 features and stop the UI from discarding data the API already serves.

1. **Free-delivery progress bar + min-order nudge in cart** — `frontend/web/src/app/cart/page.tsx`; drive from `useStore()` (`store.freeDeliveryAbovePaise`, `store.minOrderPaise`) vs `cart.itemsPaise`. Disable/annotate the checkout CTA below minimum.
2. **Product grid infinite scroll** — `page.tsx` `productsQuery` → `useInfiniteQuery` over existing `meta.nextCursor` + IntersectionObserver sentinel.
3. **Reorder / "Order again"** — `orders/[id]/page.tsx`, `orders/page.tsx` rows, and a home rail in `page.tsx`; read `GET /v1/orders/:id` items, loop `PUT /v1/cart/items` per line, route to `/cart`; skip inactive/OOS on 404.
4. **Web push wiring** — add `public/firebase-messaging-sw.js` + push/notificationclick handlers, `lib/firebase.ts` messaging, `getToken(VAPID)` behind a primed opt-in card, `POST /v1/devices`. Backend send path (`core/push.ts`, `/v1/devices`) already exists.
5. **Search typeahead + recent searches + search-within-category** — `page.tsx`: suggestion dropdown on `GET /v1/products?search=&limit=6`, localStorage recent chips, stop clearing category on input (backend already accepts q+category).
6. **PDP quick wins** — `p/[slug]/page.tsx`: image gallery over `product.images[]`, "Similar products" rail (`GET /v1/categories` → `GET /v1/products?category=`), Rx explanatory banner (`requiresRx`/`scheduleClass` already in contract), `Max {maxPerOrder} per order` helper, share via `navigator.share`.
7. **Category visual tile grid + category rails** — `page.tsx` render `Category.imageUrl` (already served); optional `/c/[slug]` landing on `GET /v1/products?category=`.
8. **Order history status tabs + load-more** — `orders/page.tsx`: pass `?status=` and consume `meta.nextCursor` (both already supported).
9. **Set default address** — `account/page.tsx`: "Set as default" button → `PATCH /v1/addresses/:id {isDefault:true}` (TX already clears others).
10. **OOS cart-line handling + delivery ETA + support tel:** — `cart/page.tsx` StockBadge + one-tap remove; checkout ETA from `distanceM`; `tel:${SUPPORT_PHONE}` button in `account/page.tsx` + order detail.
11. **A11y/UX polish** — Skeleton primitive in `packages/ui` + `ui.tsx` replacing spinners; `focus-visible:ring` in `globals.css`/Button; `aria-live="polite"` on order-status containers in `orders/[id]` + `track`; `prefers-reduced-motion` block; EmptyState `icon`+`action` props with CTAs; Inter/Noto via `next/font` in `layout.tsx`.
12. **PWA install prompt** — client component capturing `beforeinstallprompt`, gated on ≥1 DELIVERED order (from `/v1/orders`) + not-standalone.

### Batch 2 — High value, needs backend (new schema/endpoints)

1. **Coupon preview + customer offers** — `POST /v1/coupons/validate` (code+cart → `{discountPaise,totalPaise}` or `COUPON_INVALID`, reuse `pricing.ts` + `validateCoupon`) and `GET /v1/coupons` (active, in-window, customer-visible flag on `Coupon`). Wire Apply button + discount bill row in `checkout/page.tsx` and an `/offers` page.
2. **Filters + sort** — extend `ProductListQuerySchema` (`brandIn[]`, `requiresRx`, `inStock`, `min/maxPricePaise`, `discounted`, `sort` enum) + WHERE/ORDER BY in `search.ts`. Note keyset cursor assumes id-asc — non-id sorts need offset paging or a no-deep-paging cap.
3. **Substitutes** — `GET /v1/products/:slug/substitutes` (composition/salt match, Rx+schedule parity, price asc); PDP carousel with per-unit delta.
4. **Back-in-stock notify** — `StockAlert` model + `POST/DELETE /v1/products/:slug/stock-alert`; fire on GRN 0→>0 via existing notifications. Add `lowStock` bool to ProductSummary for "Only a few left".
5. **Delivery note + contactless + tip** — add `deliveryNote`, `contactless`, `tipPaise` to `Order` + `CreateOrderBodySchema`; checkout inputs; surface to driver app; tip credits driver wallet.
6. **PDP medical info + manufacturer** — nullable `uses/directions/howItWorks/sideEffects/storage/precautions/manufacturer/marketer` columns + migration; ProductSchema + ops Catalog CRUD; PDP accordions.
7. **Refund detail** — expose `refundPaise/refundInitiatedAt/refundId` on OrderDetail (already stored on Payment); refund card on order detail.
8. **Customer Rx surfacing** — short-TTL presigned GET + `fileUrl` on customer `PrescriptionSchema`; `GET /v1/prescriptions` (owner-scoped) + "My Prescriptions" screen; driver photo (`photoKey` on DriverProfile → presigned into OrderDriver).
9. **Notification preferences + account deletion** — `NotificationPreference` model + `GET/PATCH /v1/me/notification-preferences`; `DELETE /v1/me` (soft-delete/anonymize) for Play/DPDP compliance.
10. **Ratings + returns + welcome offer** — `Rating` model + `POST /v1/orders/:id/rating` (DELIVERED-only); `ReturnRequest` model + `POST /v1/orders/:id/returns` raising an ops alert; auto-issue/surface a WELCOME coupon for zero-delivered-order users.

### Batch 3 — Larger builds or need a product decision

- **Refill reminders** (§17 v1.1 #2 post-launch): `RefillReminder` model + pg-boss daily sweep + `REFILL_DUE` push + opt-in toggle. *Depends on Batch 1 web-push.*
- **Prescription locker / health-records / patient profiles**: decouple `Prescription.orderId` (nullable) + add `userId`; `Patient`/dependent model attached to Order+Rx; "For whom" selector. *Consolidate the three overlapping findings into one build.*
- **Standalone Rx-upload/callback flow** + **blocking-Rx-at-checkout decision** + **Rx resubmit-instead-of-cancel**: needs a product decision on the Rx flow (accept §18.1 deviation vs. re-implement blocking; whether rejection revives the order).
- **Wishlist + save-for-later** (merge into one store): `Wishlist(userId,productId)` + heart toggle + account tab.
- **Referral program**: needs **reward-economics decision** (who gets what, coupon vs wallet credit) before build.
- **Customer loyalty/wallet + refund-to-wallet**: needs decision on earn/redeem economics; ties in referral + first-order credits.
- **Subscriptions / auto-refill**: auto-creates orders + handles payment/stock/Rx each cycle — largest; gate behind a decision on whether refills are on the roadmap.
- **Symptom/health-concern browse**, **collections**, **personalized "For You"**, **featured/best-seller**, **frequently-bought-together**, **pack-size variants**, **map-pin address**, **i18n framework (next-intl)**, **first-run onboarding**, **cart-abandonment nudges**, **shareable tracking link**.

## 4. My recommendation

**Build Batch 1 first, immediately.** It is the highest ROI in the audit: nearly every item is high or medium value, S/M effort, and needs **zero backend** because the endpoints, contracts, and data already exist — the frontend is simply not consuming them. Critically, Batch 1 closes the credibility gap on features the blueprint marks ✅ **shipped for v1 but that don't exist in code** (reorder shortcut, free-delivery progress bar, min-order nudge in cart, web push, PWA install prompt) plus the §20 quality mandates (skeletons, focus rings, aria-live, reduced-motion). Shipping it makes the app match its own launch spec and removes the most jarring UX dead-ends (50-product cap, silent qty caps, OOS dead-ends, no reorder) at the lowest cost and risk.

Sequence Batch 1's **web-push wiring early** since Batch 2 (back-in-stock, welcome offer) and Batch 3 (refill reminders, cart abandonment) all depend on a registered device token. Then move to Batch 2, leading with **coupon preview + offers** and **filters/sort**, which are the highest-value backend items and unblock conversion. Defer Batch 3 until the **referral/loyalty reward economics and the Rx-flow direction** are decided with the product owner — those are the only gaps that genuinely need human input rather than engineering.