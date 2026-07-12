"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useOpsAlertsLive, useUnackedAlertBadge } from "@/lib/alerts";
import { isAdmin, useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui";

interface NavItem {
  label: string;
  href?: string;
  /** Not yet built — shown greyed so the full IA is visible during the build-out. */
  soon?: boolean;
  /** Small count pill (e.g. unacked alerts). */
  badge?: string;
}

const ADMIN_NAV: NavItem[] = [
  { label: "Dashboard", href: "/admin/dashboard" },
  { label: "Drivers", href: "/admin/drivers" },
  { label: "Payouts", href: "/admin/payouts" },
  { label: "Coupons", href: "/admin/coupons" },
  { label: "Users", href: "/admin/users" },
  { label: "Reports", href: "/admin/reports" },
  { label: "Settings", href: "/admin/settings" },
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
                  "flex items-center justify-between rounded-input px-3 py-1.5 text-sm",
                  active
                    ? "bg-primary-600/10 font-medium text-primary-700"
                    : "text-ink-600 hover:bg-surface-2",
                )}
              >
                {item.label}
                {item.badge && (
                  <span className="ml-2 inline-flex min-w-5 items-center justify-center rounded-pill bg-danger px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                    {item.badge}
                  </span>
                )}
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

  // Live alert wiring: the socket hook invalidates the alert queries when an
  // `alert` lands on the ops room, so the badge (and the /alerts inbox) update
  // in real time; the badge query itself polls as a reconnect fallback.
  useOpsAlertsLive();
  const { count, overflow } = useUnackedAlertBadge();

  const opsNav: NavItem[] = [
    { label: "Orders", href: "/orders" },
    {
      label: "Alerts",
      href: "/alerts",
      badge: count > 0 ? (overflow ? "50+" : String(count)) : undefined,
    },
    { label: "Products", href: "/products" },
    { label: "Stock", href: "/stock" },
  ];

  return (
    <div className="flex min-h-dvh">
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
        <div className="px-4 py-4">
          <span className="text-base font-semibold text-primary-700">MedRush</span>
          <span className="ml-1.5 text-sm text-ink-400">Ops</span>
        </div>
        <nav className="flex-1 space-y-5 overflow-auto px-2 py-2">
          <NavGroup title="Operations" items={opsNav} pathname={pathname} />
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
