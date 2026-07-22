import type { ReactNode } from "react";

/**
 * Shared prose primitives for the static legal pages (privacy, terms, licensing).
 * These are server components (no hooks) so they render inside server pages.
 */

/** Anchor id for a section heading — shared by {@link LegalSection} and {@link LegalContents}. */
function sectionId(title: string): string {
  return `s-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

/** Page-body wrapper: reading measure (~65ch), padding + vertical rhythm. */
export function LegalProse({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-[65ch] space-y-7 px-4 pb-12 pt-4">{children}</div>;
}

/**
 * Jump list for long compliance pages. Pure anchors — no JS — so it works on the
 * server-rendered page. `items` must repeat the {@link LegalSection} titles verbatim.
 */
export function LegalContents({ items }: { items: string[] }) {
  return (
    <details className="group overflow-hidden rounded-xl2 border border-line/70 bg-surface shadow-sm">
      <summary className="press flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-ink-900 [&::-webkit-details-marker]:hidden">
        On this page
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4 shrink-0 text-ink-400 transition-transform group-open:rotate-180"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </summary>
      <nav aria-label="Sections on this page" className="border-t border-line/70 px-2 pb-2 pt-1">
        <ol className="text-sm">
          {items.map((item, i) => (
            <li key={item}>
              <a
                href={`#${sectionId(item)}`}
                className="flex min-h-11 items-center gap-3 rounded-card px-2 py-2 text-ink-600 transition-colors hover:bg-primary-50 hover:text-primary-700"
              >
                <span className="w-5 shrink-0 text-right text-xs font-semibold tabular-nums text-ink-400">
                  {i + 1}
                </span>
                <span className="min-w-0">{item}</span>
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </details>
  );
}

/** A titled section: ink-900 heading over ink-600 body copy. */
export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section id={sectionId(title)} className="scroll-mt-20 space-y-2.5 border-t border-line/70 pt-6">
      <h2 className="text-base font-bold tracking-tight text-ink-900">{title}</h2>
      <div className="space-y-3 text-[15px] leading-7 text-ink-600">{children}</div>
    </section>
  );
}

/** Bulleted list styled for the prose body. */
export function LegalList({ children }: { children: ReactNode }) {
  return (
    <ul className="list-disc space-y-2 pl-5 marker:text-primary-500">{children}</ul>
  );
}

/** "Last updated" stamp shown under a page intro. */
export function LastUpdated({ date }: { date: string }) {
  return (
    <p className="inline-flex items-center gap-1.5 rounded-pill bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-600">
      <svg
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5 text-ink-400"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2" />
      </svg>
      Last updated: {date}
    </p>
  );
}

/**
 * Inline placeholder the operator must replace before go-live. Rendered in a
 * distinct amber pill so it is obvious in review that a value is still missing.
 */
export function Op({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-[13px] font-semibold text-warning ring-1 ring-inset ring-warning/20">
      [OPERATOR: {children}]
    </span>
  );
}
