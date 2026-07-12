import Link from "next/link";

/** Branded 404 — unknown console routes point back at the order board. */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <div>
        <p className="text-base font-semibold text-primary-700">
          MedRush <span className="font-normal text-ink-400">Ops</span>
        </p>
        <h1 className="mt-2 text-xl font-semibold text-ink-900">Page not found</h1>
        <p className="mt-1 text-sm text-ink-600">
          This page doesn&rsquo;t exist — the link may be stale.
        </p>
      </div>
      <Link
        href="/orders"
        className="rounded-input bg-primary-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700"
      >
        Go to the order board
      </Link>
    </div>
  );
}
