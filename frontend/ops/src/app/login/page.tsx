"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { Button, Card, Spinner } from "@/components/ui";

/** Seeded staff accounts for one-click local sign-in (dev-token path). */
const SEED_ACCOUNTS = [
  { label: "Inventory (pharmacist)", uid: "seed-firebase-inventory", phone: "+919876543212" },
  { label: "Admin (owner)", uid: "seed-firebase-admin", phone: "+919876543213" },
] as const;

export default function LoginPage() {
  const router = useRouter();
  const { user, loading, devLogin } = useAuth();
  const [uid, setUid] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in → go to the board.
  useEffect(() => {
    if (!loading && user) router.replace("/orders");
  }, [loading, user, router]);

  async function submit(nextUid: string, nextPhone: string) {
    setBusy(true);
    setError(null);
    try {
      await devLogin(nextUid.trim(), nextPhone.trim());
      router.replace("/orders");
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 401
            ? "That account is not recognised — check the Firebase UID."
            : err.message
          : "Sign-in failed",
      );
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-2 p-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-5">
          <h1 className="text-lg font-semibold text-ink-900">MedRush Ops</h1>
          <p className="text-sm text-ink-600">Sign in to the ops &amp; admin console.</p>
        </div>

        <div className="mb-4 space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-400">Quick sign-in (dev)</p>
          {SEED_ACCOUNTS.map((a) => (
            <Button
              key={a.uid}
              variant="secondary"
              className="w-full justify-start"
              disabled={busy}
              onClick={() => submit(a.uid, a.phone)}
            >
              {a.label}
            </Button>
          ))}
        </div>

        <form
          className="space-y-3 border-t border-line pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(uid, phone);
          }}
        >
          <p className="text-xs font-medium uppercase tracking-wide text-ink-400">
            Or enter credentials
          </p>
          <input
            className="w-full rounded-input border border-line px-3 py-2 text-sm outline-none focus:border-primary-600"
            placeholder="Firebase UID"
            value={uid}
            onChange={(e) => setUid(e.target.value)}
          />
          <input
            className="w-full rounded-input border border-line px-3 py-2 text-sm outline-none focus:border-primary-600"
            placeholder="Phone (+91…)"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <Button type="submit" className="w-full" loading={busy} disabled={!uid || !phone}>
            Sign in
          </Button>
        </form>

        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      </Card>
    </main>
  );
}
