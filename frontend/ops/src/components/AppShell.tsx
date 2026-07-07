"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isAdmin, useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui";

interface NavItem {
  label: string;
  href?: string;
  /** Not yet built — shown greyed so the full IA is visible during the build-out. */
  soon?: boolean;
}

const OPS_NAV: NavItem[] = [
  { label: "Orders", href: "/orders" },
  { label: "Rx queue", soon: true },
  { label: "Products", soon: true },
  { label: "Batches", soon: true },
  { label: "Stock", soon: true },
];

const ADMIN_NAV: NavItem[] = [
  { label: "Dashboard", soon: true },
  { label: "Drivers", soon: true },
  { label: "Payouts", soon: true },
  { label: "Coupons", soon: true },
  { label: "Users", soon: true },
  { label: "Reports", soon: true },
  { label: "Settings", soon: true },
];

function NavGroup({ title, items, pathname }: { title: string; items: NavItem[]; pathname: string }) {
  return (
    <div>
      <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">{title}</p>
      <ul className="space-y-0.5">
        {items.map((item) => {
          const active = item.href && (pathname === item.href || pathname.startsWith(item.href + "/"));
          if (item.soon || !item.href) {
            return (
              <li
                key={item.label}
                className="flex items-center justify-between rounded-input px-3 py-1.5 text-sm text-ink-400"
              >
                {item.label}
                <span className="text-[10px] uppercase">soon</span>
              </li>
            );
          }
          return (
            <li key={item.label}>
              <Link
                href={item.href}
                className={cn(
                  "block rounded-input px-3 py-1.5 text-sm",
                  active
                    ? "bg-primary-600/10 font-medium text-primary-700"
                    : "text-ink-600 hover:bg-surface-2",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();

  return (
    <div className="flex min-h-dvh">
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
        <div className="px-4 py-4">
          <span className="text-base font-semibold text-primary-700">MedRush</span>
          <span className="ml-1.5 text-sm text-ink-400">Ops</span>
        </div>
        <nav className="flex-1 space-y-5 overflow-auto px-2 py-2">
          <NavGroup title="Operations" items={OPS_NAV} pathname={pathname} />
          {isAdmin(user?.role) && <NavGroup title="Admin" items={ADMIN_NAV} pathname={pathname} />}
        </nav>
        <div className="border-t border-line p-3">
          <div className="mb-2 truncate px-2 text-xs text-ink-600">
            {user?.name ?? user?.phone}
            <span className="ml-1 text-ink-400">· {user?.role}</span>
          </div>
          <Button variant="ghost" className="w-full justify-start" onClick={logout}>
            Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl px-6 py-6">{children}</div>
      </main>
    </div>
  );
}
