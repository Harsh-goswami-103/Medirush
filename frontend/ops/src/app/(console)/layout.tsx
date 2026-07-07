"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { isOps, useAuth } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { Spinner } from "@/components/ui";

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }
  if (!isOps(user.role)) {
    return (
      <div className="flex min-h-dvh items-center justify-center px-6 text-center text-sm text-danger">
        This console requires an ops (INVENTORY) or admin account.
      </div>
    );
  }
  return <AppShell>{children}</AppShell>;
}
