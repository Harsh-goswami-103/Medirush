"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { Button, Card, Spinner } from "@/components/ui";
import { TopBar } from "@/components/AppShell";

/** Seeded customer for one-tap local sign-in (dev-token path). */
const SEED_CUSTOMER = { uid: "seed-firebase-customer", phone: "+919876543210" };

export default function LoginPage() {
  const router = useRouter();
  const { user, loading, devLogin } = useAuth();
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user) router.replace("/account");
  }, [loading, user, router]);

  async function signIn(uid: string, phoneNo: string, displayName?: string) {
    setBusy(true);
    setError(null);
    try {
      await devLogin(uid, phoneNo, displayName);
      router.replace("/account");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Sign-in failed");
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
    <div>
      <TopBar title="Sign in" back />
      <div className="p-4">
        <Card className="p-5">
          <p className="mb-4 text-sm text-ink-600">
            Sign in to add items and place orders. In this local build no OTP is needed.
          </p>

          <Button
            className="mb-4 w-full"
            loading={busy}
            onClick={() => signIn(SEED_CUSTOMER.uid, SEED_CUSTOMER.phone)}
          >
            Continue as demo customer
          </Button>

          <form
            className="space-y-3 border-t border-line pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              // A fresh phone maps to a new dev account (auth/sync creates it).
              void signIn(`dev-web-${phone.replace(/\D/g, "")}`, phone, name || undefined);
            }}
          >
            <p className="text-xs font-medium uppercase tracking-wide text-ink-400">Or a new account</p>
            <input
              className="w-full rounded-input border border-line px-3 py-2 text-sm outline-none focus:border-primary-600"
              placeholder="Phone (+91…)"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <input
              className="w-full rounded-input border border-line px-3 py-2 text-sm outline-none focus:border-primary-600"
              placeholder="Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" variant="secondary" className="w-full" loading={busy} disabled={phone.length < 10}>
              Continue
            </Button>
          </form>

          {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        </Card>
      </div>
    </div>
  );
}
