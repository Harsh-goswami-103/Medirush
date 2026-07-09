import { useRef, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { MIN_PAYOUT_PAISE, type PayoutStatus } from "@medrush/contracts";
import { ApiError } from "@/lib/api";
import { usePayouts, useRequestPayout, useWallet } from "@/lib/queries";
import { makeIdempotencyKey } from "@/lib/uid";
import { Badge, Button, Card, Divider, Field, Loading, Row, Txt } from "@/components/ui";
import { colors, font, space } from "@/lib/theme";
import { dateTime, rupees } from "@/lib/format";

const STATUS_TONE: Record<PayoutStatus, "warning" | "info" | "success" | "danger"> = {
  REQUESTED: "warning",
  APPROVED: "info",
  PAID: "success",
  REJECTED: "danger",
};

/** Request a payout to UPI/bank, and see the status of past requests (§9.6). */
export default function PayoutScreen() {
  const router = useRouter();
  const wallet = useWallet();
  const payouts = usePayouts();
  const request = useRequestPayout();

  const [amount, setAmount] = useState(""); // rupees
  const [account, setAccount] = useState("");
  const [method, setMethod] = useState<"UPI" | "BANK">("UPI");
  const [err, setErr] = useState<string | null>(null);
  const keyRef = useRef(makeIdempotencyKey());

  const balance = wallet.data?.balancePaise ?? 0;
  const amountPaise = Math.round((parseFloat(amount) || 0) * 100);

  async function submit() {
    setErr(null);
    if (amountPaise < MIN_PAYOUT_PAISE) {
      setErr(`Minimum payout is ${rupees(MIN_PAYOUT_PAISE)}.`);
      return;
    }
    if (amountPaise > balance) {
      setErr(`You can withdraw at most ${rupees(balance)}.`);
      return;
    }
    if (account.trim().length < 3) {
      setErr(method === "UPI" ? "Enter your UPI ID." : "Enter your account number.");
      return;
    }
    try {
      await request.mutateAsync({
        idempotencyKey: keyRef.current,
        body: { amountPaise, upiOrAcct: account.trim(), method },
      });
      keyRef.current = makeIdempotencyKey(); // arm a fresh key for the next request
      Alert.alert("Payout requested", "Ops will process it shortly.", [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't request the payout.");
    }
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: space.lg, gap: space.md }}
      keyboardShouldPersistTaps="handled"
    >
      <Row style={{ justifyContent: "space-between" }}>
        <Txt size={font.xl} weight="800">
          Request payout
        </Txt>
        <Txt color="muted">Bal {rupees(balance)}</Txt>
      </Row>

      <Card style={{ gap: space.md }}>
        <Field
          label="Amount (₹)"
          value={amount}
          onChangeText={(t) => setAmount(t.replace(/[^\d.]/g, ""))}
          keyboardType="decimal-pad"
          placeholder="500"
          hint={`Minimum ${rupees(MIN_PAYOUT_PAISE)}`}
        />

        <View style={{ gap: space.xs }}>
          <Txt size={font.sm} color="muted" weight="600">
            Method
          </Txt>
          <Row gap={space.sm}>
            <Button
              title="UPI"
              variant={method === "UPI" ? "primary" : "subtle"}
              style={{ flex: 1 }}
              onPress={() => setMethod("UPI")}
            />
            <Button
              title="Bank"
              variant={method === "BANK" ? "primary" : "subtle"}
              style={{ flex: 1 }}
              onPress={() => setMethod("BANK")}
            />
          </Row>
        </View>

        <Field
          label={method === "UPI" ? "UPI ID" : "Account number"}
          value={account}
          onChangeText={setAccount}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={method === "UPI" ? "name@bank" : "Account / IFSC"}
        />

        {err ? (
          <Txt color="danger" size={font.sm}>
            {err}
          </Txt>
        ) : null}

        <Button title="Request payout" size="lg" loading={request.isPending} onPress={submit} />
      </Card>

      <Txt weight="700" style={{ marginTop: space.sm }}>
        Past requests
      </Txt>
      {payouts.isLoading ? (
        <Card>
          <Loading />
        </Card>
      ) : (payouts.data?.length ?? 0) === 0 ? (
        <Txt color="faint" size={font.sm}>
          No payout requests yet.
        </Txt>
      ) : (
        <Card>
          {payouts.data!.map((p, i) => (
            <View key={p.id}>
              {i > 0 ? <Divider /> : null}
              <Row style={{ justifyContent: "space-between", paddingVertical: space.sm }}>
                <View style={{ flex: 1 }}>
                  <Txt weight="700">{rupees(p.amountPaise)}</Txt>
                  <Txt color="faint" size={font.xs}>
                    {p.method} • {dateTime(p.requestedAt)}
                  </Txt>
                </View>
                <Badge label={p.status} tone={STATUS_TONE[p.status]} />
              </Row>
            </View>
          ))}
        </Card>
      )}

      <Button title="Cancel" variant="ghost" onPress={() => router.back()} />
    </ScrollView>
  );
}
