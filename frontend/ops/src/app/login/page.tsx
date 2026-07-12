"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { FIREBASE_ENABLED } from "@/lib/env";
import { friendlyAuthError, RECAPTCHA_CONTAINER_ID } from "@/lib/firebase";
import { Button, Card, Spinner } from "@/components/ui";
import { Field, TextInput } from "@/components/kit";

/**
 * Staff sign-in. Firebase configured → phone-OTP (the only production path).
 * Firebase absent in a dev build → dev-token shortcuts. Firebase absent in
 * production → a loud "not configured" card; there is deliberately no silent
 * dev-token fallback.
 *
 * Local const on purpose: NODE_ENV is inlined by `next build`, so the whole
 * dev panel (incl. the seeded staff UIDs below) folds away and is stripped
 * from production bundles.
 */
const DEV_LOGIN_ENABLED = process.env.NODE_ENV !== "production" && !FIREBASE_ENABLED;

const RESEND_COOLDOWN_S = 30;

export default function LoginPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  // Already signed in → go to the board.
  useEffect(() => {
    if (!loading && user) router.replace("/orders");
  }, [loading, user, router]);

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
        {FIREBASE_ENABLED ? (
          <PhoneOtpForm onSignedIn={() => router.replace("/orders")} />
        ) : DEV_LOGIN_ENABLED ? (
          <DevLoginPanel onSignedIn={() => router.replace("/orders")} />
        ) : (
          <NotConfigured />
        )}
      </Card>
    </main>
  );
}

/* --------------------------------------------------- Firebase phone → OTP */

function PhoneOtpForm({ onSignedIn }: { onSignedIn: () => void }) {
  const { sendOtp, confirmOtp } = useAuth();
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [phone, setPhone] = useState(""); // national part, 10 digits
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown === 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const phoneValid = /^[6-9]\d{9}$/.test(phone);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await sendOtp(`+91${phone}`);
      setCode("");
      setStep("otp");
      setCooldown(RESEND_COOLDOWN_S);
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await confirmOtp(code.trim());
      onSignedIn(); // stay "busy" — the page unmounts on redirect
    } catch (err) {
      // Covers Firebase codes, the role-gate message and ApiError messages.
      setError(friendlyAuthError(err));
      setBusy(false);
    }
  }

  return (
    <div>
      {step === "phone" ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Field label="Mobile number" hint="You'll receive a one-time code by SMS.">
            <div className="flex items-center gap-2">
              <span className="rounded-input border border-line bg-surface-2 px-3 py-2 text-sm text-ink-600">
                +91
              </span>
              <TextInput
                type="tel"
                inputMode="numeric"
                autoComplete="tel-national"
                placeholder="9876543210"
                maxLength={10}
                autoFocus
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
              />
            </div>
          </Field>
          <Button type="submit" className="w-full" loading={busy} disabled={!phoneValid}>
            Send code
          </Button>
        </form>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void confirm();
          }}
        >
          <Field label="One-time code" hint={`Sent by SMS to +91 ${phone}.`}>
            <TextInput
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              maxLength={6}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            />
          </Field>
          <Button type="submit" className="w-full" loading={busy} disabled={code.length !== 6}>
            Verify &amp; sign in
          </Button>
          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              className="text-ink-600 hover:underline"
              disabled={busy}
              onClick={() => {
                setStep("phone");
                setError(null);
              }}
            >
              Change number
            </button>
            <button
              type="button"
              className="text-primary-700 hover:underline disabled:text-ink-400 disabled:no-underline"
              disabled={busy || cooldown > 0}
              onClick={() => void send()}
            >
              {cooldown > 0 ? `Resend code (${cooldown}s)` : "Resend code"}
            </button>
          </div>
        </form>
      )}

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      {/* Invisible reCAPTCHA mounts here (required by Firebase phone auth). */}
      <div id={RECAPTCHA_CONTAINER_ID} />
    </div>
  );
}

/* ------------------------------------------------ dev-token panel (dev only) */

/** Seeded staff accounts for one-click local sign-in — dev builds only. */
const SEED_ACCOUNTS = [
  { label: "Inventory (pharmacist)", uid: "seed-firebase-inventory", phone: "+919876543212" },
  { label: "Admin (owner)", uid: "seed-firebase-admin", phone: "+919876543213" },
] as const;

function DevLoginPanel({ onSignedIn }: { onSignedIn: () => void }) {
  const { devLogin } = useAuth();
  const [uid, setUid] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(nextUid: string, nextPhone: string) {
    setBusy(true);
    setError(null);
    try {
      await devLogin(nextUid.trim(), nextPhone.trim());
      onSignedIn();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 401
            ? "That account is not recognised — check the Firebase UID."
            : err.message
          : err instanceof Error
            ? err.message
            : "Sign-in failed",
      );
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-4 space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-400">
          Quick sign-in (dev build — Firebase not configured)
        </p>
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
        <TextInput placeholder="Firebase UID" value={uid} onChange={(e) => setUid(e.target.value)} />
        <TextInput
          placeholder="Phone (+91…)"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <Button type="submit" className="w-full" loading={busy} disabled={!uid || !phone}>
          Sign in
        </Button>
      </form>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </div>
  );
}

/* ------------------------------------------- unconfigured production build */

function NotConfigured() {
  return (
    <div className="rounded-card border border-danger/20 bg-danger/5 p-4" role="alert">
      <p className="text-sm font-semibold text-danger">Sign-in is not configured</p>
      <p className="mt-1 text-sm text-ink-600">
        This build has no Firebase project: the NEXT_PUBLIC_FIREBASE_* variables were not set
        at build time, so staff sign-in cannot work. Rebuild with the Firebase web config to
        enable phone-OTP sign-in.
      </p>
    </div>
  );
}
