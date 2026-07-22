import { AppShell } from "@/components/AppShell";

/**
 * The installed-app experience: a centred mobile column with the bottom tab
 * bar (§20.5). Everything a signed-in customer touches lives in this group;
 * the marketing landing page deliberately sits outside it.
 */
export default function AppGroupLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
