import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import type { DeliverResult } from "@medrush/contracts";
import { ApiError } from "@/lib/api";
import { useActiveDelivery, useDeliver, usePickedUp } from "@/lib/queries";
import { Badge, Button, Card, Divider, EmptyState, Field, Loading, Row, Txt } from "@/components/ui";
import { colors, font, radius, space } from "@/lib/theme";
import { callNumber, distance, navigateTo, rupees, rupeesWhole } from "@/lib/format";

/**
 * The active delivery — the driver's step-by-step to done:
 *   ASSIGNED → navigate to store → "Picked up"
 *   PICKED_UP → navigate to customer → collect COD (if any) → OTP → "Complete"
 * Delivery credits the wallet; the result screen shows the earnings + new balance.
 */
export default function ActiveScreen() {
  const router = useRouter();
  const { data: active, isLoading } = useActiveDelivery();
  const pickedUp = usePickedUp();
  const deliver = useDeliver();
  const [otp, setOtp] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<DeliverResult | null>(null);

  if (result) return <DeliveredScreen result={result} onDone={() => router.replace("/")} />;

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Loading label="Loading delivery…" />
      </View>
    );
  }

  if (!active) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: "center" }}>
        <EmptyState title="No active delivery" subtitle="This delivery is already complete." />
        <View style={{ padding: space.lg }}>
          <Button title="Back to home" variant="subtle" onPress={() => router.replace("/")} />
        </View>
      </View>
    );
  }

  const isCod = active.paymentMethod === "COD";
  const assigned = active.status === "ASSIGNED";

  async function onPickedUp() {
    setErr(null);
    try {
      await pickedUp.mutateAsync(active!.deliveryId);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't mark picked up.");
    }
  }

  async function onDeliver() {
    setErr(null);
    if (!/^\d{4}$/.test(otp)) {
      setErr("Enter the 4-digit OTP the customer gives you.");
      return;
    }
    try {
      const res = await deliver.mutateAsync({
        deliveryId: active!.deliveryId,
        body: {
          otp,
          ...(isCod && active!.codDuePaise != null
            ? { codCollectedPaise: active!.codDuePaise }
            : {}),
        },
      });
      setResult(res);
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.code === "OTP_LOCKED"
            ? "Too many wrong OTPs. Ask ops to unlock this delivery."
            : e.message
          : "Delivery failed.",
      );
    }
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: space.lg, gap: space.md, paddingTop: space.xl }}
      keyboardShouldPersistTaps="handled"
    >
      <Row style={{ justifyContent: "space-between" }}>
        <Txt size={font.xl} weight="800">
          Order #{active.orderNo}
        </Txt>
        <Badge label={assigned ? "Assigned" : "Picked up"} tone={assigned ? "info" : "success"} />
      </Row>

      {/* pickup */}
      <Card style={{ gap: space.sm }}>
        <Row style={{ justifyContent: "space-between" }}>
          <Txt weight="700">📦 Pickup — store</Txt>
        </Row>
        <Txt color="muted" size={font.sm}>
          {active.pickup.address}
        </Txt>
        <Button
          title="Navigate to store"
          variant="subtle"
          onPress={() => navigateTo(active.pickup)}
        />
      </Card>

      {/* drop */}
      <Card style={{ gap: space.sm }}>
        <Txt weight="700">📍 Drop — customer</Txt>
        <Txt weight="600">{active.customer.name ?? "Customer"}</Txt>
        <Txt color="muted" size={font.sm}>
          {active.drop.address}
        </Txt>
        <Txt color="muted" size={font.sm}>
          {distance(active.distanceM)} • {active.itemCount} item{active.itemCount === 1 ? "" : "s"}
        </Txt>
        <Row gap={space.sm}>
          <Button
            title="Call"
            variant="subtle"
            style={{ flex: 1 }}
            onPress={() => callNumber(active.customer.phone)}
          />
          <Button
            title="Navigate"
            variant="subtle"
            style={{ flex: 1 }}
            onPress={() => navigateTo(active.drop)}
          />
        </Row>
      </Card>

      {/* payment */}
      <Card tone="alt" style={{ gap: space.xs }}>
        <Row style={{ justifyContent: "space-between" }}>
          <Txt color="muted">Payment</Txt>
          <Badge label={isCod ? "COD" : "Prepaid"} tone={isCod ? "warning" : "success"} />
        </Row>
        {isCod ? (
          <Row style={{ justifyContent: "space-between" }}>
            <Txt weight="700">Collect cash</Txt>
            <Txt color="cash" size={font.xl} weight="900">
              {active.codDuePaise != null ? rupees(active.codDuePaise) : "—"}
            </Txt>
          </Row>
        ) : (
          <Txt color="success" size={font.sm}>
            Already paid online — collect nothing.
          </Txt>
        )}
      </Card>

      {err ? (
        <Txt color="danger" size={font.sm}>
          {err}
        </Txt>
      ) : null}

      {assigned ? (
        <Button
          title="Picked up from store"
          size="lg"
          loading={pickedUp.isPending}
          onPress={onPickedUp}
        />
      ) : (
        <Card style={{ gap: space.md }}>
          <Txt weight="700">Complete delivery</Txt>
          {isCod ? (
            <Txt color="muted" size={font.sm}>
              Collect{" "}
              <Txt color="cash" weight="800" size={font.sm}>
                {active.codDuePaise != null ? rupees(active.codDuePaise) : ""}
              </Txt>{" "}
              in cash, then enter the customer's 4-digit OTP.
            </Txt>
          ) : (
            <Txt color="muted" size={font.sm}>
              Enter the customer's 4-digit OTP to complete.
            </Txt>
          )}
          <Field
            label="Delivery OTP"
            value={otp}
            onChangeText={(t) => setOtp(t.replace(/\D/g, "").slice(0, 4))}
            keyboardType="number-pad"
            maxLength={4}
            placeholder="1234"
            style={{ marginBottom: space.xs }}
          />
          <Button
            title="Complete delivery"
            variant="success"
            size="lg"
            loading={deliver.isPending}
            onPress={onDeliver}
          />
        </Card>
      )}

      <Divider />
      <Button title="Back to home" variant="ghost" onPress={() => router.replace("/")} />
    </ScrollView>
  );
}

function DeliveredScreen({ result, onDone }: { result: DeliverResult; onDone: () => void }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, padding: space.lg, justifyContent: "center", gap: space.lg }}>
      <View style={{ alignItems: "center", gap: space.sm }}>
        <View
          style={{
            width: 88,
            height: 88,
            borderRadius: radius.pill,
            backgroundColor: colors.successBg,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Txt size={44}>✅</Txt>
        </View>
        <Txt size={font.xxl} weight="900">
          Delivered!
        </Txt>
      </View>

      <Card style={{ gap: space.md }}>
        <Row style={{ justifyContent: "space-between" }}>
          <Txt color="muted">Earned this trip</Txt>
          <Txt color="success" size={font.xl} weight="900">
            {rupeesWhole(result.commissionPaise)}
          </Txt>
        </Row>
        <Divider />
        <Row style={{ justifyContent: "space-between" }}>
          <Txt color="muted">Wallet balance</Txt>
          <Txt size={font.lg} weight="800">
            {rupees(result.walletBalancePaise)}
          </Txt>
        </Row>
      </Card>

      <Button title="Back to home" size="lg" onPress={onDone} />
    </View>
  );
}
