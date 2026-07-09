import { View } from "react-native";
import type { Offer } from "@medrush/contracts";
import { Badge, Button, Card, Divider, Row, Txt } from "@/components/ui";
import { colors, font, radius, space } from "@/lib/theme";
import { countdown, distance, rupeesWhole } from "@/lib/format";
import { useSecondsLeft } from "@/lib/useCountdown";

/**
 * Incoming delivery offer — the money decision. Commission is the hero number;
 * a live countdown bar shows the shrinking accept window. Accept is the big
 * primary action; Reject passes it to the next driver.
 */
export function OfferCard({
  offer,
  onAccept,
  onReject,
  accepting = false,
  rejecting = false,
}: {
  offer: Offer;
  onAccept: () => void;
  onReject: () => void;
  accepting?: boolean;
  rejecting?: boolean;
}) {
  const secondsLeft = useSecondsLeft(offer.expiresAt);
  const expired = secondsLeft <= 0;
  // Bar width relative to the 25s offer window (OFFER_EXPIRES_SEC).
  const pct = Math.min(1, secondsLeft / 25);
  const urgent = secondsLeft <= 8;

  return (
    <Card style={{ gap: space.md, borderColor: urgent && !expired ? colors.warning : colors.border }}>
      <Row style={{ justifyContent: "space-between" }}>
        <Badge label={`Wave ${offer.wave}`} tone="info" />
        <Txt color={urgent ? "warning" : "muted"} weight="700">
          {expired ? "Expired" : `${countdown(secondsLeft)} left`}
        </Txt>
      </Row>

      {/* countdown bar */}
      <View style={{ height: 6, backgroundColor: colors.surfaceAlt, borderRadius: radius.pill }}>
        <View
          style={{
            height: 6,
            width: `${pct * 100}%`,
            backgroundColor: urgent ? colors.warning : colors.primary,
            borderRadius: radius.pill,
          }}
        />
      </View>

      <Row style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <View>
          <Txt color="muted" size={font.sm}>
            Order #{offer.orderNo}
          </Txt>
          <Txt color="cash" size={font.display} weight="900">
            {rupeesWhole(offer.commissionPaise)}
          </Txt>
          <Txt color="muted" size={font.sm}>
            earnings
          </Txt>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Txt size={font.xl} weight="800">
            {distance(offer.distanceM)}
          </Txt>
          <Txt color="muted" size={font.sm}>
            to customer
          </Txt>
        </View>
      </Row>

      <Divider />

      <View style={{ gap: space.xs }}>
        <Row style={{ alignItems: "flex-start" }} gap={space.sm}>
          <Txt>📦</Txt>
          <Txt color="muted" size={font.sm} style={{ flex: 1 }} numberOfLines={2}>
            {offer.pickup.address}
          </Txt>
        </Row>
        <Row style={{ alignItems: "flex-start" }} gap={space.sm}>
          <Txt>📍</Txt>
          <Txt color="muted" size={font.sm} style={{ flex: 1 }} numberOfLines={2}>
            {offer.drop.address}
          </Txt>
        </Row>
      </View>

      <Button
        title={expired ? "Offer expired" : "Accept"}
        onPress={onAccept}
        loading={accepting}
        disabled={expired || rejecting}
        size="lg"
      />
      <Button
        title="Reject"
        variant="ghost"
        onPress={onReject}
        loading={rejecting}
        disabled={accepting}
      />
    </Card>
  );
}
