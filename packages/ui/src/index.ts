/**
 * @medrush/ui — shared web components for the customer PWA and ops/admin apps.
 *
 * Phase 0: honest stub so the package builds under turbo and workspace wiring is real.
 *
 * TODO(Phase 3): implement the component inventory from docs/BLUEPRINT.md §20.3:
 *   Button (primary/secondary/ghost/destructive, loading), Input + PhoneInput + OTPInput,
 *   SearchBar (debounced), Select, QuantityStepper, Chip/Badge (incl. RxBadge, StockBadge),
 *   ProductCard, CartBar (sticky), PriceRow, BottomSheet, Modal, Toast, Skeleton set,
 *   EmptyState, ErrorState (retry), StatusTimeline, MapView (MapLibre wrapper), StatCard,
 *   DataTable (sort/filter/csv), Tabs, SideNav (ops), ConfirmDialog, FileDropzone (Rx),
 *   CountdownRing (driver offer).
 * Styling comes from the shared Tailwind preset: @medrush/config/tailwind/preset.js (§20.2 tokens).
 */

/** Placeholder export so the barrel is a real ESM module until Phase 3 components land. */
export const UI_PACKAGE_STATUS = "stub: components arrive in Phase 3 (BLUEPRINT §20.3)" as const;
