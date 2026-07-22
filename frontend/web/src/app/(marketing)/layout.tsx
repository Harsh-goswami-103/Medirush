/**
 * Marketing chrome: full-bleed and responsive, with no app shell or bottom tab
 * bar. Only the public landing page lives here — everything a customer does
 * after entering the store is in the `(app)` group's mobile column.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-surface">{children}</div>;
}
