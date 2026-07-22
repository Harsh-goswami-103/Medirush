import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Txt } from "@/components/ui";
import { useDispatch } from "@/lib/dispatch";
import { colors, font, HIT_HEIGHT, radius, space } from "@/lib/theme";

/**
 * Live-tracking connectivity indicator (§20 — dark, sunlight-readable, large).
 * Renders nothing while tracking is healthy; when the dispatch socket is down
 * or GPS points are being dropped (lib/locationSink.ts) it tells the rider the
 * customer's map has gone stale, so a lost delivery is not a silent failure.
 *
 * Mount it on the active-delivery surface only — it is not gated on a delivery
 * being in progress.
 */
export function LiveTrackingBanner({ style }: { style?: StyleProp<ViewStyle> }) {
  const { connected, location } = useDispatch();
  const degraded = !connected || !location.senderRegistered || location.droppedRecent > 0;
  if (!degraded) return null;

  return (
    <View style={[styles.banner, style]} accessibilityRole="alert">
      <ActivityIndicator color={colors.warning} />
      <View style={styles.text}>
        <Txt size={font.base} weight="800" color="warning">
          Live tracking offline — reconnecting
        </Txt>
        <Txt size={font.sm} color="muted">
          {location.droppedRecent > 0
            ? `${location.droppedRecent} location update${location.droppedRecent === 1 ? "" : "s"} not sent. Stay on this screen.`
            : "The customer's map is not updating. Stay on this screen."}
        </Txt>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: HIT_HEIGHT,
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  text: { flex: 1, gap: space.xs },
});
