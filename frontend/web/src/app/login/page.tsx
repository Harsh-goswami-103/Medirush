"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { firebaseAuthErrorMessage, isFirebaseConfigured } from "@/lib/firebase";
import { Button, Card, Spinner } from "@/components/ui";
import { TopBar } from "@/components/AppShell";

/**
 * Sign-in. Firebase configured → phone-OTP (the production path). Otherwise a
 * dev build shows the dev-token login; a production build without Firebase is a
 * misconfiguration and says so loudly — there is no silent dev-token fallback.
 */

/** Dev login ships only in dev builds — production bundles tree-shake it out. */
const DEV_LOGIN_ENABLED = process.env.NODE_ENV !== "production";

/** Seeded customer for one-tap local sign-in (dev-token path). */
const SEED_CUSTOMER = { uid: "seed-firebase-customer", phone: "+919876543210" };

const RESEND_COOLDOWN_S = 30;

const INPUT_CLASS =
  "w-full rounded-input border border-line px-3 py-2 text-sm outline-none focus:border-primary-600";

export default function LoginPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && user) router.replace("/account");
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  const done = () => router.replace("/account");

  return (
    <div>
      <TopBar title="Sign in" back />
      <div className="p-4">
        {isFirebaseConfigured ? (
          <OtpLoginCard onDone={done} />
        ) : DEV_LOGIN_ENABLED ? (
          <DevLoginCard onDone={done} />
        ) : (
          <NotConfiguredCard />
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------- Firebase phone-OTP */

function OtpLoginCard({ onDone }: { onDone: () => void }) {
  const { sendOtp, confirmOtp } = useAuth();
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [digits, setDigits] = useState(""); // 10-digit local number (+91)
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown === 0) return;
    const t = setTimeout(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function requestCode() {
    setBusy(true);
    setError(null);
    try {
      await sendOtp(`+91${digits}`);
      setStep("otp");
      setCode("");
      setCooldown(RESEND_COOLDOWN_S);
    } catch (e) {
      setError(firebaseAuthErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    setBusy(true);
    setError(null);
    try {
      await confirmOtp(code);
      onDone(); // stay "busy" through the redirect
    } catch (e) {
      setError(e instanceof ApiError ? e.message : firebaseAuthErrorMessage(e));
      setBusy(false);
    }
  }

  if (step === "otp") {
    return (
      <Card className="p-5">
        <p className="mb-4 text-sm text-ink-600">
          Enter the 6-digit code sent to <span className="font-medium text-ink-900">+91 {digits}</span>.
        </p>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void verifyCode();
          }}
        >
          <input
            className={`${INPUT_CLASS} text-center text-lg tracking-[0.5em]`}
            placeholder="••••••"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            autoFocus
          />
          <Button type="submit" className="w-full" loading={busy} disabled={code.length !== 6}>
            Verify &amp; sign in
          </Button>
        </form>
        <div className="mt-4 flex items-center justify-between text-sm">
          <button
            type="button"
            className="text-ink-600 hover:text-ink-900"
            onClick={() => {
              setStep("phone");
              setError(null);
            }}
          >
            Change number
          </button>
          <button
            type="button"
            className="font-medium text-primary-600 disabled:cursor-not-allowed disabled:text-ink-400"
            disabled={busy || cooldown > 0}
            onClick={() => void requestCode()}
          >
            {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
          </button>
        </div>
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <p className="mb-4 text-sm text-ink-600">
        Sign in with your mobile number to add items and place orders. We&apos;ll text you a
        one-time code.
      </p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void requestCode();
        }}
      >
        <div className="flex items-center gap-2">
          <span className="rounded-input border border-line bg-surface-2 px-3 py-2 text-sm text-ink-600">
            +91
          </span>
          <input
            className={INPUT_CLASS}
            placeholder="10-digit mobile number"
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            maxLength={10}
            value={digits}
            onChange={(e) => setDigits(e.target.value.replace(/\D/g, "").slice(0, 10))}
            autoFocus
          />
        </div>
        <Button type="submit" className="w-full" loading={busy} disabled={digits.length !== 10}>
          Send code
        </Button>
      </form>
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </Card>
  );
}

/* -------------------------------------------------------- dev-token login */

function DevLoginCard({ onDone }: { onDone: () => void }) {
  const { devLogin } = useAuth();
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(uid: string, phoneNo: string, displayName?: string) {
    setBusy(true);
    setError(null);
    try {
      await devLogin(uid, phoneNo, displayName);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Sign-in failed");
      setBusy(false);
    }
  }

  return (
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
          className={INPUT_CLASS}
          placeholder="Phone (+91…)"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <input
          className={INPUT_CLASS}
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
  );
}

/* -------------------------------------------------- misconfigured build */

/** Production build with no Firebase config — fail loudly, never fall back to dev tokens. */
function NotConfiguredCard() {
  return (
    <Card className="border-danger/20 bg-danger/5 p-5">
      <p className="text-sm font-semibold text-danger">Sign-in is not configured</p>
      <p className="mt-2 text-sm text-ink-600">
        This build was deployed without phone sign-in configuration
        (NEXT_PUBLIC_FIREBASE_*), so accounts cannot sign in. If you keep seeing
        this, please contact support — this is a deployment issue, not a problem
        with your account.
      </p>
    </Card>
  );
}
