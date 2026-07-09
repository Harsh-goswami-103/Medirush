import { useState } from "react";
import { View } from "react-native";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { SEED_DRIVER } from "@/lib/env";
import { Button, Card, Field, H1, Screen, Txt } from "@/components/ui";
import { colors, space } from "@/lib/theme";

/**
 * Driver sign-in. Local/dev: dev-login with the seeded verified driver
 * (`seed-firebase-driver`) — one tap and you're on shift. The uid/phone are
 * editable for testing other identities. Production swaps this for Firebase
 * phone-OTP; only the token exchange changes (the rest of the app is unaffected).
 */
export default function LoginScreen() {
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
      const msg =
        e instanceof ApiError
          ? e.code === "NETWORK"
            ? "Can't reach the server. Check EXPO_PUBLIC_API_URL and that the API is running."
            : e.message
          : "Sign-in failed";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen scroll contentStyle={{ flexGrow: 1, justifyContent: "center" }}>
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
          Sign in to start your shift
        </Txt>
      </View>

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
        <Button title="Sign in" onPress={signIn} loading={busy} size="lg" />
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
