import type { ReactNode } from "react";

/**
 * Shared prose primitives for the static legal pages (privacy, terms, licensing).
 * These are server components (no hooks) so they render inside server pages.
 */

/** Page-body wrapper: consistent padding + vertical rhythm between sections. */
export function LegalProse({ children }: { children: ReactNode }) {
  return <div className="space-y-6 p-4">{children}</div>;
}

/** A titled section: ink-900 heading over ink-600 body copy. */
export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
      <div className="space-y-2 text-sm leading-6 text-ink-600">{children}</div>
    </section>
  );
}

/** Bulleted list styled for the prose body. */
export function LegalList({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
}

/** "Last updated" stamp shown under a page intro. */
export function LastUpdated({ date }: { date: string }) {
  return <p className="text-xs text-ink-400">Last updated: {date}</p>;
}

/**
 * Inline placeholder the operator must replace before go-live. Rendered in a
 * distinct amber pill so it is obvious in review that a value is still missing.
 */
export function Op({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-warning/10 px-1 font-medium text-warning">[OPERATOR: {children}]</span>
  );
}
