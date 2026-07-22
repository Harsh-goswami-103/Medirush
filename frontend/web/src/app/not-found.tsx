import Link from "next/link";

/** 404 boundary — unknown routes and `notFound()` calls land here. */
export default function NotFound() {
  return (
    <div className="bg-mesh flex min-h-dvh items-center justify-center px-5 py-10">
      <div className="glass w-full max-w-sm animate-reveal-up rounded-sheet2 p-7 text-center shadow-glass">
        <div
          className="mx-auto flex h-16 w-16 items-center justify-center rounded-xl2 bg-gradient-to-br from-primary-600 to-primary-500 text-white shadow-glow"
          aria-hidden
        >
          <svg
            viewBox="0 0 24 24"
            className="h-8 w-8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35" />
            <path d="M8.5 11h5" />
          </svg>
        </div>

        <p className="mt-5 text-sm font-bold uppercase tracking-[0.2em] text-primary-700">
          Error 404
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink-900">Page not found</h1>
        <p className="mx-auto mt-2 max-w-[36ch] text-[15px] leading-6 text-ink-600">
          The page you&rsquo;re looking for doesn&rsquo;t exist or may have moved. Everything else is
          right where you left it.
        </p>

        <div className="mt-6 space-y-2.5">
          <Link
            href="/shop"
            className="press flex h-12 w-full items-center justify-center rounded-card bg-gradient-to-r from-primary-600 to-primary-500 text-[15px] font-semibold text-white shadow-glow"
          >
            Back to the shop
          </Link>
          <Link
            href="/orders"
            className="press flex h-12 w-full items-center justify-center rounded-card border border-line bg-surface text-[15px] font-semibold text-ink-900 transition-colors hover:bg-surface-2"
          >
            View my orders
          </Link>
        </div>
      </div>
    </div>
  );
}
