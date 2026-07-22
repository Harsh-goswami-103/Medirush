"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { firebaseAuthErrorMessage, isFirebaseConfigured } from "@/lib/firebase";
import { Button, Spinner } from "@/components/ui";
import { Reveal } from "@/components/motion";

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
  "h-12 w-full rounded-card border border-line bg-surface/90 px-4 text-[15px] text-ink-900 placeholder:text-ink-400 outline-none transition-colors focus:border-primary-600";

/** Teal gradient CTA — `disabled:bg-none` lets the Button's disabled fill show through. */
const CTA_CLASS =
  "press h-12 w-full rounded-card bg-gradient-to-r from-primary-600 to-primary-500 text-[15px] font-semibold shadow-glow disabled:bg-none disabled:shadow-none";

export default function LoginPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && user) router.replace("/account");
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="bg-mesh flex min-h-[calc(100dvh-4.5rem)] items-center justify-center">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  const done = () => router.replace("/account");

  return (
    <div className="bg-mesh min-h-[calc(100dvh-4.5rem)]">
      <header className="px-4 pt-4">
        <Link
          href="/shop"
          aria-label="Back to shop"
          className="press glass flex h-11 w-11 items-center justify-center rounded-full text-ink-600 shadow-sm"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </Link>
      </header>

      <div className="px-5 pb-12 pt-5">
        <Reveal>
          <div
            className="flex h-14 w-14 animate-float items-center justify-center rounded-xl2 bg-gradient-to-br from-primary-600 to-primary-500 text-white shadow-glow"
            aria-hidden
          >
            <svg
              viewBox="0 0 24 24"
              className="h-7 w-7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 3l7.5 3v5.2c0 4.4-3 8.3-7.5 9.8-4.5-1.5-7.5-5.4-7.5-9.8V6L12 3z" />
              <path d="M12 9v6M9 12h6" />
            </svg>
          </div>
          <h1 className="mt-5 text-[28px] font-bold leading-tight tracking-tight text-ink-900">
            Welcome to <span className="text-primary-700">MedRush</span>
          </h1>
          <p className="mt-2 text-[15px] leading-6 text-ink-600">
            Sign in to order medicines, upload prescriptions and track every delivery.
          </p>
        </Reveal>

        <Reveal delayMs={80} className="mt-6">
          {isFirebaseConfigured ? (
            <OtpLoginCard onDone={done} />
          ) : DEV_LOGIN_ENABLED ? (
            <DevLoginCard onDone={done} />
          ) : (
            <NotConfiguredCard />
          )}
        </Reveal>

        <Reveal delayMs={160} className="mt-6">
          <ul className="grid grid-cols-3 gap-2">
            <TrustChip label="Licensed pharmacy" path="M12 3l7.5 3v5.2c0 4.4-3 8.3-7.5 9.8-4.5-1.5-7.5-5.4-7.5-9.8V6L12 3zM9.3 12.2l1.9 1.9 3.7-3.9" />
            <TrustChip label="Pharmacist-checked" path="M8 3h8l1 4H7l1-4zM7 7h10v13a1 1 0 01-1 1H8a1 1 0 01-1-1V7zm5 4v6m-3-3h6" />
            <TrustChip label="Fast delivery" path="M3 7h11v9H3V7zm11 3h4l3 3v3h-7v-6zM7.5 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm10 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
          </ul>
        </Reveal>

        <p className="mt-6 text-center text-xs leading-5 text-ink-600">
          By continuing you agree to our{" "}
          <Link href="/terms" className="font-semibold text-primary-700 underline underline-offset-2">
            Terms
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="font-semibold text-primary-700 underline underline-offset-2">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- primitives */

function TrustChip({ label, path }: { label: string; path: string }) {
  return (
    <li className="glass flex flex-col items-center gap-1.5 rounded-xl2 px-2 py-3 text-center shadow-sm">
      <svg
        viewBox="0 0 24 24"
        className="h-5 w-5 text-primary-700"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d={path} />
      </svg>
      <span className="text-[11px] font-semibold leading-tight text-ink-900">{label}</span>
    </li>
  );
}

function AuthCard({ children }: { children: ReactNode }) {
  return <div className="glass rounded-sheet2 p-5 shadow-glass">{children}</div>;
}

function FormError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="mt-3 flex items-start gap-2 rounded-card border border-danger/20 bg-danger/5 px-3 py-2.5 text-sm font-medium text-danger"
    >
      <svg
        viewBox="0 0 24 24"
        className="mt-0.5 h-4 w-4 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M12 8v5M12 16.5v.5M12 21a9 9 0 100-18 9 9 0 000 18z" />
      </svg>
      {message}
    </p>
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
      <AuthCard>
        <h2 className="text-lg font-bold tracking-tight text-ink-900">Enter your code</h2>
        <p className="mt-1 text-sm leading-6 text-ink-600">
          We sent a 6-digit code to{" "}
          <span className="font-semibold text-ink-900">+91 {digits}</span>.
        </p>
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void verifyCode();
          }}
        >
          <label className="block">
            <span className="sr-only">6-digit verification code</span>
            <input
              className={`${INPUT_CLASS} h-14 text-center text-xl font-semibold tracking-[0.5em]`}
              placeholder="••••••"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              autoFocus
            />
          </label>
          <Button type="submit" className={CTA_CLASS} loading={busy} disabled={code.length !== 6}>
            Verify &amp; sign in
          </Button>
        </form>
        <div className="mt-4 flex items-center justify-between gap-2 text-sm">
          <button
            type="button"
            className="press -ml-2 min-h-11 rounded-card px-2 font-medium text-ink-600 transition-colors hover:text-ink-900"
            onClick={() => {
              setStep("phone");
              setError(null);
            }}
          >
            Change number
          </button>
          <button
            type="button"
            className="press -mr-2 min-h-11 rounded-card px-2 font-semibold text-primary-700 disabled:cursor-not-allowed disabled:text-ink-400"
            disabled={busy || cooldown > 0}
            onClick={() => void requestCode()}
            aria-live="polite"
          >
            {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
          </button>
        </div>
        {error && <FormError message={error} />}
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <h2 className="text-lg font-bold tracking-tight text-ink-900">Sign in</h2>
      <p className="mt-1 text-sm leading-6 text-ink-600">
        Enter your mobile number and we&apos;ll text you a one-time code.
      </p>
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void requestCode();
        }}
      >
        <label className="block">
          <span className="sr-only">Mobile number</span>
          <div className="flex items-center gap-2">
            <span className="flex h-12 shrink-0 items-center rounded-card border border-line bg-surface-2 px-3 text-[15px] font-medium text-ink-600">
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
        </label>
        <Button type="submit" className={CTA_CLASS} loading={busy} disabled={digits.length !== 10}>
          Send code
        </Button>
      </form>
      {error && <FormError message={error} />}
    </AuthCard>
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
    <AuthCard>
      <span className="inline-flex items-center rounded-pill bg-warning/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-warning">
        Local build
      </span>
      <h2 className="mt-3 text-lg font-bold tracking-tight text-ink-900">Sign in</h2>
      <p className="mt-1 text-sm leading-6 text-ink-600">
        Sign in to add items and place orders. In this local build no OTP is needed.
      </p>

      <Button
        className={`${CTA_CLASS} mt-4`}
        loading={busy}
        onClick={() => signIn(SEED_CUSTOMER.uid, SEED_CUSTOMER.phone)}
      >
        Continue as demo customer
      </Button>

      <form
        className="mt-5 space-y-3 border-t border-line/70 pt-5"
        onSubmit={(e) => {
          e.preventDefault();
          // A fresh phone maps to a new dev account (auth/sync creates it).
          void signIn(`dev-web-${phone.replace(/\D/g, "")}`, phone, name || undefined);
        }}
      >
        <p className="text-[11px] font-bold uppercase tracking-wider text-ink-400">
          Or a new account
        </p>
        <label className="block">
          <span className="sr-only">Phone number</span>
          <input
            className={INPUT_CLASS}
            placeholder="Phone (+91…)"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="sr-only">Name (optional)</span>
          <input
            className={INPUT_CLASS}
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <Button
          type="submit"
          variant="secondary"
          className="press h-12 w-full rounded-card text-[15px] font-semibold"
          loading={busy}
          disabled={phone.length < 10}
        >
          Continue
        </Button>
      </form>

      {error && <FormError message={error} />}
    </AuthCard>
  );
}

/* -------------------------------------------------- misconfigured build */

/** Production build with no Firebase config — fail loudly, never fall back to dev tokens. */
function NotConfiguredCard() {
  return (
    <div className="rounded-sheet2 border border-danger/20 bg-danger/5 p-5 shadow-sm">
      <p className="flex items-center gap-2 text-sm font-bold text-danger">
        <svg
          viewBox="0 0 24 24"
          className="h-5 w-5 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 8v5M12 16.5v.5M12 21a9 9 0 100-18 9 9 0 000 18z" />
        </svg>
        Sign-in is not configured
      </p>
      <p className="mt-2 text-sm leading-6 text-ink-600">
        This build was deployed without phone sign-in configuration
        (NEXT_PUBLIC_FIREBASE_*), so accounts cannot sign in. If you keep seeing
        this, please contact support — this is a deployment issue, not a problem
        with your account.
      </p>
    </div>
  );
}
