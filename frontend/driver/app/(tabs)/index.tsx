import { useState } from "react";
import { Alert, RefreshControl, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useDuty } from "@/lib/duty";
import { useDispatch } from "@/lib/dispatch";
import {
  useAcceptOffer,
  useActiveDelivery,
  useOffers,
  useRejectOffer,
} from "@/lib/queries";
import { Badge, Button, Card, EmptyState, Loading, Row, Txt } from "@/components/ui";
import { OfferCard } from "@/components/OfferCard";
import { colors, font, radius, space } from "@/lib/theme";
import { distance, rupeesWhole } from "@/lib/format";

/** Home / duty screen — the driver's command center for the current shift. */
export default function HomeScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { online, verified, busy, error, setOnline } = useDuty();
  const { connected } = useDispatch();
  const active = useActiveDelivery();
  const offers = useOffers(online && !active.data);
  const accept = useAcceptOffer();
  const reject = useRejectOffer();
  const [actingOn, setActingOn] = useState<string | null>(null);

  async function toggleOnline() {
    try {
      await setOnline(!online);
    } catch {
      // error surfaced via `error` from useDuty
    }
  }

  async function onAccept(offerId: string) {
    setActingOn(offerId);
    try {
      await accept.mutateAsync(offerId);
      router.push("/active");
    } catch (e) {
      const msg =
        e instanceof ApiError && e.code === "OFFER_TAKEN"
          ? "That offer was just taken by another driver."
          : e instanceof ApiError
            ? e.message
            : "Couldn't accept the offer.";
      Alert.alert("Offer unavailable", msg);
      void offers.refetch();
    } finally {
      setActingOn(null);
    }
  }

  async function onReject(offerId: string) {
    setActingOn(offerId);
    try {
      await reject.mutateAsync(offerId);
    } catch {
      // Rejection failures are non-critical; the list refreshes on its own.
    } finally {
      setActingOn(null);
    }
  }

  const offerList = offers.data ?? [];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: space.lg, gap: space.md, paddingTop: space.xl }}
      refreshControl={
        <RefreshControl
          tintColor={colors.primary}
          refreshing={offers.isRefetching || active.isRefetching}
          onRefresh={() => {
            void active.refetch();
            void offers.refetch();
          }}
        />
      }
    >
      {/* header */}
      <Row style={{ justifyContent: "space-between" }}>
        <View>
          <Txt color="muted">Hi{user?.name ? `, ${user.name.split(" ")[0]}` : ""} 👋</Txt>
          <Txt size={font.xl} weight="800">
            {online ? "You're online" : "You're offline"}
          </Txt>
        </View>
        <Row gap={space.xs}>
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: connected ? colors.success : colors.textFaint,
            }}
          />
          <Txt size={font.xs} color={connected ? "success" : "faint"}>
            {connected ? "Live" : "Offline"}
          </Txt>
        </Row>
      </Row>

      {/* duty toggle */}
      {verified === false ? (
        <Card tone="alt" style={{ gap: space.sm }}>
          <Badge label="Not verified" tone="warning" />
          <Txt color="muted" size={font.sm}>
            Your driver account isn't verified yet. Ops must verify you before you
            can go online. Contact the store.
          </Txt>
        </Card>
      ) : (
        <Button
          title={online ? "Go offline" : "Go online"}
          variant={online ? "subtle" : "primary"}
          size="lg"
          loading={busy}
          onPress={toggleOnline}
        />
      )}
      {error ? (
        <Txt color="danger" size={font.sm}>
          {error}
        </Txt>
      ) : null}

      {/* active delivery takes over the screen */}
      {active.isLoading ? (
        <Card>
          <Loading />
        </Card>
      ) : active.data ? (
        <ActiveBanner
          orderNo={active.data.orderNo}
          statusLabel={active.data.status === "ASSIGNED" ? "Pick up from store" : "On the way"}
          commissionPaise={active.data.commissionPaise}
          distanceM={active.data.distanceM}
          onOpen={() => router.push("/active")}
        />
      ) : online ? (
        offerList.length > 0 ? (
          offerList.map((offer) => (
            <OfferCard
              key={offer.offerId}
              offer={offer}
              onAccept={() => onAccept(offer.offerId)}
              onReject={() => onReject(offer.offerId)}
              accepting={actingOn === offer.offerId && accept.isPending}
              rejecting={actingOn === offer.offerId && reject.isPending}
            />
          ))
        ) : (
          <Card style={{ paddingVertical: space.xxl }}>
            <EmptyState
              title="Waiting for offers…"
              subtitle="Stay near the store. New delivery offers will buzz and appear here."
            />
          </Card>
        )
      ) : (
        <Card style={{ paddingVertical: space.xxl }}>
          <EmptyState
            title="You're off duty"
            subtitle="Go online to start receiving delivery offers."
          />
        </Card>
      )}
    </ScrollView>
  );
}

function ActiveBanner({
  orderNo,
  statusLabel,
  commissionPaise,
  distanceM,
  onOpen,
}: {
  orderNo: string;
  statusLabel: string;
  commissionPaise: number;
  distanceM: number;
  onOpen: () => void;
}) {
  return (
    <Card style={{ gap: space.md, borderColor: colors.primary }}>
      <Row style={{ justifyContent: "space-between" }}>
        <Badge label="Active delivery" tone="success" />
        <Txt color="muted" size={font.sm}>
          #{orderNo}
        </Txt>
      </Row>
      <Row style={{ justifyContent: "space-between" }}>
        <View>
          <Txt size={font.lg} weight="800">
            {statusLabel}
          </Txt>
          <Txt color="muted" size={font.sm}>
            {distance(distanceM)} • {rupeesWhole(commissionPaise)} earnings
          </Txt>
        </View>
        <View
          style={{
            backgroundColor: colors.successBg,
            borderRadius: radius.pill,
            paddingHorizontal: space.md,
            paddingVertical: space.xs,
          }}
        >
          <Txt color="success" weight="700">
            In progress
          </Txt>
        </View>
      </Row>
      <Button title="Open delivery" onPress={onOpen} size="lg" />
    </Card>
  );
}
