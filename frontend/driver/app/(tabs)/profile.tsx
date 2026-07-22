import { useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { APP_VERSION, API_BASE_URL } from "@/lib/env";
import { useAuth } from "@/lib/auth";
import { useDuty } from "@/lib/duty";
import { Badge, Button, Card, Divider, Row, Txt } from "@/components/ui";
import { font, space } from "@/lib/theme";

/** Profile — identity, verification/duty status, and sign-out. */
export default function ProfileScreen() {
  const { user, logout } = useAuth();
  const { online, verified, busy, setOnline } = useDuty();
  const [signingOut, setSigningOut] = useState(false);

  /**
   * PATCH /v1/driver/status is the only way the server learns the driver is off
   * duty (there is no GET to reconcile against), so the toggle must succeed
   * BEFORE the session goes away. If it fails — no network, 500 — signing out
   * silently would leave them online server-side and still in the dispatch
   * pool, so surface it and let them retry or knowingly override.
   */
  async function goOfflineThenSignOut() {
    setSigningOut(true);
    try {
      await setOnline(false);
    } catch {
      setSigningOut(false);
      Alert.alert(
        "Couldn't go offline",
        "You're still on duty and may keep getting offers. Check your connection and try again.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Try again", onPress: () => void goOfflineThenSignOut() },
          { text: "Sign out anyway", style: "destructive", onPress: () => void logout() },
        ],
      );
      return;
    }
    await logout();
  }

  function confirmLogout() {
    if (online) {
      Alert.alert(
        "You're currently on duty",
        "Go offline and sign out? You'll stop receiving offers.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Go offline and sign out",
            style: "destructive",
            onPress: () => void goOfflineThenSignOut(),
          },
        ],
      );
      return;
    }
    Alert.alert("Sign out?", "You'll stop receiving offers until you sign in again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => void logout() },
    ]);
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: space.lg, gap: space.md, paddingTop: space.xl }}
    >
      <Txt size={font.xl} weight="800">
        Profile
      </Txt>

      <Card style={{ gap: space.sm }}>
        <Txt size={font.lg} weight="800">
          {user?.name ?? "Driver"}
        </Txt>
        <Row style={{ justifyContent: "space-between" }}>
          <Txt color="muted">{user?.phone}</Txt>
          <Row gap={space.xs}>
            <Badge label={user?.role ?? "DRIVER"} tone="info" />
            {verified === true ? (
              <Badge label="Verified" tone="success" />
            ) : verified === false ? (
              <Badge label="Unverified" tone="warning" />
            ) : null}
          </Row>
        </Row>
      </Card>

      <Card style={{ gap: space.md }}>
        <Row style={{ justifyContent: "space-between" }}>
          <Txt weight="700">Duty status</Txt>
          <Badge label={online ? "Online" : "Offline"} tone={online ? "success" : "neutral"} />
        </Row>
        {online ? (
          <Button
            title="Go offline"
            variant="subtle"
            loading={busy}
            onPress={() => void setOnline(false)}
          />
        ) : (
          <Txt color="muted" size={font.sm}>
            You're off duty. Go online from the Home tab to receive offers.
          </Txt>
        )}
      </Card>

      <Card tone="alt" style={{ gap: space.xs }}>
        <Txt color="muted" size={font.sm} weight="600">
          App
        </Txt>
        <Divider />
        <Row style={{ justifyContent: "space-between" }}>
          <Txt color="faint" size={font.xs}>
            Version
          </Txt>
          <Txt color="faint" size={font.xs}>
            {APP_VERSION}
          </Txt>
        </Row>
        <Row style={{ justifyContent: "space-between" }}>
          <Txt color="faint" size={font.xs}>
            API
          </Txt>
          <Txt color="faint" size={font.xs} numberOfLines={1} style={{ flex: 1, textAlign: "right" }}>
            {API_BASE_URL}
          </Txt>
        </Row>
      </Card>

      <View style={{ marginTop: space.md }}>
        <Button
          title="Sign out"
          variant="danger"
          loading={signingOut}
          onPress={confirmLogout}
        />
      </View>
    </ScrollView>
  );
}
