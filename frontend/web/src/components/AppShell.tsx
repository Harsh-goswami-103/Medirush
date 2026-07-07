"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCart } from "@/lib/cart";
import { cn } from "@/lib/cn";

/** 24px stroke icons for the tab bar. */
function Icon({ path, filled }: { path: string; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth={filled ? 2.2 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={path} />
    </svg>
  );
}

const TABS = [
  { href: "/", label: "Home", icon: "M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10" },
  { href: "/orders", label: "Orders", icon: "M7 3h10l2 4v13a1 1 0 01-1 1H6a1 1 0 01-1-1V7zM5 7h14M9 12h6M9 16h6" },
  { href: "/cart", label: "Cart", icon: "M4 5h2l2.4 11.2a1 1 0 001 .8h7.7a1 1 0 001-.8L21 8H7M9 21a1 1 0 100-2 1 1 0 000 2zm8 0a1 1 0 100-2 1 1 0 000 2z", badge: true },
  { href: "/account", label: "Account", icon: "M12 12a4 4 0 100-8 4 4 0 000 8zM5 21a7 7 0 0114 0" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { itemCount } = useCart();

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col bg-surface shadow-lg">
      <main className="flex-1 pb-[4.5rem]">{children}</main>

      <nav className="fixed bottom-0 left-1/2 z-40 w-full max-w-md -translate-x-1/2 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
        <div className="grid grid-cols-4">
          {TABS.map((t) => {
            const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={cn(
                  "flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium",
                  active ? "text-primary-700" : "text-ink-400",
                )}
              >
                <span className="relative">
                  <Icon path={t.icon} filled={active} />
                  {t.badge && itemCount > 0 && (
                    <span className="absolute -right-2.5 -top-1 min-w-4 rounded-pill bg-primary-600 px-1 text-center text-[10px] font-semibold leading-4 text-white">
                      {itemCount}
                    </span>
                  )}
                </span>
                {t.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

/** Sticky page top bar (title + optional back + right slot). */
export function TopBar({
  title,
  back,
  right,
}: {
  title: string;
  back?: boolean;
  right?: React.ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-surface/95 px-4 py-3 backdrop-blur">
      {back && (
        <Link href=".." className="-ml-1 text-ink-600" aria-label="Back">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </Link>
      )}
      <h1 className="flex-1 truncate text-base font-semibold text-ink-900">{title}</h1>
      {right}
    </header>
  );
}
