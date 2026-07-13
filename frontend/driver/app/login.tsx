import { useState } from "react";
import { View } from "react-native";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { phoneAuthErrorMessage } from "@/lib/firebase";
import { SEED_DRIVER } from "@/lib/env";
import { useSecondsLeft } from "@/lib/useCountdown";
import { Button, Card, Field, H1, Row, Screen, Txt } from "@/components/ui";
import { colors, font, HIT_HEIGHT, radius, space } from "@/lib/theme";

/**
 * Driver sign-in — three modes mirroring the backend's auth posture:
 *  - Native Firebase in the build → phone-OTP (+91, 6-digit code, 30s resend).
 *    After the OTP verifies, auth.tsx exchanges the Firebase ID token via
 *    POST /v1/auth/sync (once) + GET /v1/me. Unverified drivers still sign in
 *    fine — the Home screen shows the "Not verified" state and the backend
 *    403s driver actions until ops verifies them.
 *  - No Firebase + dev build → dev-login with the seeded verified driver
 *    (`seed-firebase-driver`) minting the backend `dev:<uid>:<phone>` token.
 *  - No Firebase + release build → loud "sign-in is not configured" card
 *    (never a silent dev-token fallback).
 */
export default function LoginScreen() {
  const { firebaseAvailable } = useAuth();
  if (firebaseAvailable) return <PhoneOtpLogin />;
  if (__DEV__) return <DevLogin />;
  return <NotConfiguredScreen />;
}

/* ------------------------------------------------------------ shared bits */

function Masthead({ subtitle }: { subtitle: string }) {
  return (
    <View style={{ alignItems: "center", marginBottom: space.xl }}>
      <View
        style={{
          width: 72,
          height: 72,
          borderRadius: 20,
          backgroundColor: colors.primary,
          alignItems: "center",
          justifyContent: "center",
          marginBottom: space.lg,
        }}
      >
        <Txt size={36} weight="900" color="text" style={{ color: colors.onPrimary }}>
          ⚡
        </Txt>
      </View>
      <H1>MedRush Driver</H1>
      <Txt color="muted" style={{ marginTop: space.xs }}>
        {subtitle}
      </Txt>
    </View>
  );
}

function friendlyError(e: unknown): string {
  if (e instanceof ApiError) {
    return e.code === "NETWORK"
      ? "Can't reach the server. Check EXPO_PUBLIC_API_URL and that the API is running."
      : e.message;
  }
  return phoneAuthErrorMessage(e);
}

/* -------------------------------------------------- production: phone-OTP */

const RESEND_COOLDOWN_MS = 30_000;

function PhoneOtpLogin() {
  const { startPhoneSignIn, confirmOtp } = useAuth();
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [digits, setDigits] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState<string>(() => new Date().toISOString());
  const resendIn = useSecondsLeft(resendAt);

  const phoneE164 = `+91${digits}`;
  const phoneValid = /^[6-9]\d{9}$/.test(digits);

  function onPhoneChange(text: string) {
    let s = text.replace(/\D/g, "");
    // Normalise pasted numbers: "+91 98765 43210" / "09876543210".
    if (s.length > 10 && s.startsWith("91")) s = s.slice(2);
    if (s.length > 10 && s.startsWith("0")) s = s.slice(1);
    setDigits(s.slice(0, 10));
  }

  async function sendCode(resend: boolean) {
    setBusy(true);
    setError(null);
    try {
      await startPhoneSignIn(phoneE164);
      if (!resend) {
        setCode("");
        setStep("otp");
      }
      setResendAt(new Date(Date.now() + RESEND_COOLDOWN_MS).toISOString());
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      await confirmOtp(code.trim());
      // The root navigator redirects to Home on `user` becoming set.
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen scroll contentStyle={{ flexGrow: 1, justifyContent: "center" }}>
      <Masthead subtitle="Sign in to start your shift" />

      {step === "phone" ? (
        <Card style={{ gap: space.md }}>
          <Txt size={font.sm} color="muted" weight="600">
            Mobile number
          </Txt>
          <Row gap={space.sm}>
            <View
              style={{
                height: HIT_HEIGHT,
                paddingHorizontal: space.md,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surfaceAlt,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Txt weight="700">+91</Txt>
            </View>
            <Field
              style={{ flex: 1 }}
              value={digits}
              onChangeText={onPhoneChange}
              keyboardType="number-pad"
              maxLength={10}
              placeholder="98765 43210"
              autoComplete="tel"
              textContentType="telephoneNumber"
              autoFocus
            />
          </Row>
          {error ? (
            <Txt color="danger" size={14}>
              {error}
            </Txt>
          ) : null}
          <Button
            title="Send OTP"
            onPress={() => void sendCode(false)}
            loading={busy}
            disabled={!phoneValid}
            size="lg"
          />
          <Txt color="faint" size={12}>
            We'll text a 6-digit code to verify this number.
          </Txt>
        </Card>
      ) : (
        <Card style={{ gap: space.md }}>
          <Txt color="muted">
            Enter the 6-digit code sent to +91 {digits}
          </Txt>
          <Field
            label="OTP"
            value={code}
            onChangeText={(t) => setCode(t.replace(/\D/g, "").slice(0, 6))}
            keyboardType="number-pad"
            maxLength={6}
            placeholder="123456"
            autoComplete="sms-otp"
            textContentType="oneTimeCode"
            autoFocus
          />
          {error ? (
            <Txt color="danger" size={14}>
              {error}
            </Txt>
          ) : null}
          <Button
            title="Verify & sign in"
            onPress={() => void verify()}
            loading={busy}
            disabled={code.length !== 6}
            size="lg"
          />
          <Row gap={space.sm} style={{ justifyContent: "space-between" }}>
            <Button
              title="Change number"
              variant="ghost"
              size="sm"
              onPress={() => {
                setStep("phone");
                setError(null);
              }}
            />
            <Button
              title={resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
              variant="subtle"
              size="sm"
              disabled={resendIn > 0 || busy}
              onPress={() => void sendCode(true)}
            />
          </Row>
        </Card>
      )}
    </Screen>
  );
}

/* ------------------------------------------- dev build without Firebase */

function DevLogin() {
  const { devLogin } = useAuth();
  const [uid, setUid] = useState<string>(SEED_DRIVER.firebaseUid);
  const [phone, setPhone] = useState<string>(SEED_DRIVER.phone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      await devLogin(uid.trim(), phone.trim());
      // The root navigator redirects to Home on `user` becoming set.
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen scroll contentStyle={{ flexGrow: 1, justifyContent: "center" }}>
      <Masthead subtitle="Sign in to start your shift" />

      <Card style={{ gap: space.md }}>
        <Field
          label="Driver ID (dev)"
          value={uid}
          onChangeText={setUid}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="seed-firebase-driver"
        />
        <Field
          label="Phone"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          placeholder="+9199…"
        />
        {error ? (
          <Txt color="danger" size={14}>
            {error}
          </Txt>
        ) : null}
        <Button title="Sign in" onPress={() => void signIn()} loading={busy} size="lg" />
      </Card>

      <Txt color="faint" size={12} align="center" style={{ marginTop: space.lg }}>
        Production uses Firebase phone-OTP. This dev sign-in mints the local
        {" "}
        <Txt color="faint" size={12} weight="700">
          dev:&lt;id&gt;:&lt;phone&gt;
        </Txt>{" "}
        token against your running API.
      </Txt>
    </Screen>
  );
}

/* --------------------------- release build without Firebase: fail loudly */

function NotConfiguredScreen() {
  return (
    <Screen contentStyle={{ justifyContent: "center" }}>
      <Card style={{ borderColor: colors.danger, borderWidth: 1, gap: space.sm }}>
        <Txt size={font.lg} weight="800" color="danger">
          Sign-in is not configured
        </Txt>
        <Txt color="muted">
          This build is missing Firebase — google-services.json was not present
          when it was built, so phone sign-in cannot work. Rebuild the app with
          the Firebase config provisioned (see the production checklist).
        </Txt>
      </Card>
    </Screen>
  );
}
