import { useMemo, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import type { DriverHistoryEntry } from "@medrush/contracts";
import { useHistory } from "@/lib/queries";
import { Button, Card, Divider, EmptyState, Loading, Row, StatCard, Txt } from "@/components/ui";
import { colors, font, space } from "@/lib/theme";
import { clockTime, distance, rupees } from "@/lib/format";

/** Daily delivery history + earnings totals (§7.2 GET /driver/history). */
export default function HistoryScreen() {
  const [offset, setOffset] = useState(0); // 0 = today, negative = past days

  const dateParam = useMemo(() => {
    if (offset === 0) return undefined; // server defaults to IST today
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  }, [offset]);

  const history = useHistory(dateParam);
  const totals = history.data?.totals;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: space.lg, gap: space.md, paddingTop: space.xl }}
      refreshControl={
        <RefreshControl
          tintColor={colors.primary}
          refreshing={history.isRefetching}
          onRefresh={() => void history.refetch()}
        />
      }
    >
      <Txt size={font.xl} weight="800">
        History
      </Txt>

      {/* day selector */}
      <Row style={{ justifyContent: "space-between" }}>
        <Button title="◀ Prev" variant="subtle" size="sm" onPress={() => setOffset((o) => o - 1)} />
        <Txt weight="700">{offset === 0 ? "Today" : (history.data?.date ?? dateParam)}</Txt>
        <Button
          title="Next ▶"
          variant="subtle"
          size="sm"
          disabled={offset >= 0}
          onPress={() => setOffset((o) => Math.min(0, o + 1))}
        />
      </Row>

      {/* totals */}
      <Row gap={space.sm}>
        <StatCard label="Deliveries" value={String(totals?.count ?? 0)} />
        <StatCard label="Earned" value={rupees(totals?.commissionPaise ?? 0)} tone="success" />
      </Row>
      {totals && totals.codCollectedPaise > 0 ? (
        <Card tone="alt">
          <Row style={{ justifyContent: "space-between" }}>
            <Txt color="muted">Cash collected (owe store)</Txt>
            <Txt color="cash" weight="800">
              {rupees(totals.codCollectedPaise)}
            </Txt>
          </Row>
        </Card>
      ) : null}

      {/* list */}
      {history.isLoading ? (
        <Card>
          <Loading />
        </Card>
      ) : (history.data?.deliveries.length ?? 0) === 0 ? (
        <Card style={{ paddingVertical: space.xl }}>
          <EmptyState title="No deliveries" subtitle="Completed deliveries for this day appear here." />
        </Card>
      ) : (
        <Card>
          {history.data!.deliveries.map((d, i) => (
            <View key={d.deliveryId}>
              {i > 0 ? <Divider /> : null}
              <DeliveryRow entry={d} />
            </View>
          ))}
        </Card>
      )}
    </ScrollView>
  );
}

function DeliveryRow({ entry }: { entry: DriverHistoryEntry }) {
  return (
    <Row style={{ justifyContent: "space-between", paddingVertical: space.sm }}>
      <View style={{ flex: 1 }}>
        <Txt weight="600">#{entry.orderNo}</Txt>
        <Txt color="faint" size={font.xs}>
          {clockTime(entry.deliveredAt)} • {distance(entry.distanceM)}
          {entry.codCollectedPaise != null ? ` • COD ${rupees(entry.codCollectedPaise)}` : ""}
        </Txt>
      </View>
      <Txt color="success" weight="800">
        +{rupees(entry.commissionPaise)}
      </Txt>
    </Row>
  );
}
