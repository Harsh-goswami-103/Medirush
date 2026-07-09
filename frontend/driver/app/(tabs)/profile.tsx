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

  function confirmLogout() {
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
        <Button title="Sign out" variant="danger" onPress={confirmLogout} />
      </View>
    </ScrollView>
  );
}
