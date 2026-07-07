"use client";

import { AuthProvider } from "@/lib/auth";
import { QueryProvider } from "@/lib/query";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <AuthProvider>{children}</AuthProvider>
    </QueryProvider>
  );
}
