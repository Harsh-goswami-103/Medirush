"use client";

import { isAdmin, useAuth } from "@/lib/auth";

/**
 * Admin sub-tree guard. The parent (console) layout already ensures a loaded,
 * ops-or-admin user; here we additionally gate ADMIN-only screens (§8.3).
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!isAdmin(user?.role)) {
    return (
      <div className="py-16 text-center text-sm text-danger">
        Admin access is required for this section.
      </div>
    );
  }
  return <>{children}</>;
}
