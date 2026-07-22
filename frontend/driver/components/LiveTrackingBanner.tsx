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
          {/*
            The headline must agree with the LiveTrackingDot beside it. The dot's
            predicate is `connected` alone; this banner's is stricter (it also
            fires on unsent pings). Saying "offline" while the socket is up would
            put a green "Live" chip directly above a red "offline" banner and
            teach the driver to distrust both.
          */}
          {connected ? "Live tracking degraded" : "Live tracking offline — reconnecting"}
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

/**
 * Always-on socket-status chip — the same dot + "Live"/"Offline" the Home screen
 * (app/(tabs)/index.tsx) puts in its header. Mid-delivery the driver never sees
 * Home, so without this the only connectivity signal on the screen that matters
 * most is the degraded banner above, which by design is invisible when healthy —
 * i.e. "nothing on screen" would have to mean both "fine" and "not wired up".
 * The chip makes "fine" an explicit, glanceable state on both screens alike.
 *
 * Deliberately mirrors Home's `connected` only: the nuance (dropped pings, sender
 * not registered) is spelled out by LiveTrackingBanner rather than crammed into
 * a 8px dot, and keeping the predicate identical keeps the two screens honest.
 */
export function LiveTrackingDot() {
  const { connected } = useDispatch();
  return (
    <View
      style={styles.dotRow}
      accessibilityRole="text"
      accessibilityLabel={connected ? "Live tracking connected" : "Live tracking offline"}
    >
      <View
        style={[
          styles.dot,
          { backgroundColor: connected ? colors.success : colors.textFaint },
        ]}
      />
      <Txt size={font.xs} color={connected ? "success" : "faint"}>
        {connected ? "Live" : "Offline"}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  dotRow: { flexDirection: "row", alignItems: "center", gap: space.xs },
  dot: { width: 8, height: 8, borderRadius: 4 },
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
