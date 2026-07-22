import { RefreshControl, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { MIN_PAYOUT_PAISE, type TxnType, type WalletTxn } from "@medrush/contracts";
import { isTipTxn, useWallet, useWalletTxns } from "@/lib/queries";
import { Badge, Button, Card, Divider, EmptyState, Loading, Row, Txt } from "@/components/ui";
import { colors, font, space } from "@/lib/theme";
import { dateTime, rupees } from "@/lib/format";

/** Wallet — balance, request-payout entry, and the ledger (§9.6). */
export default function WalletScreen() {
  const router = useRouter();
  const wallet = useWallet();
  const txns = useWalletTxns();

  const balance = wallet.data?.balancePaise ?? 0;
  const canPayout = balance >= MIN_PAYOUT_PAISE;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: space.lg, gap: space.md, paddingTop: space.xl }}
      refreshControl={
        <RefreshControl
          tintColor={colors.primary}
          refreshing={wallet.isRefetching || txns.isRefetching}
          onRefresh={() => {
            void wallet.refetch();
            void txns.refetch();
          }}
        />
      }
    >
      <Txt size={font.xl} weight="800">
        Wallet
      </Txt>

      <Card style={{ gap: space.sm, alignItems: "center", paddingVertical: space.xl }}>
        <Txt color="muted">Available balance</Txt>
        {wallet.isLoading ? (
          <Loading />
        ) : (
          <Txt size={font.display} weight="900">
            {rupees(balance)}
          </Txt>
        )}
        <Button
          title="Request payout"
          size="lg"
          disabled={!canPayout}
          onPress={() => router.push("/payout")}
          style={{ alignSelf: "stretch", marginTop: space.sm }}
        />
        {!canPayout ? (
          <Txt color="faint" size={font.xs} align="center">
            Minimum payout is {rupees(MIN_PAYOUT_PAISE)}.
          </Txt>
        ) : null}
      </Card>

      <Txt weight="700" style={{ marginTop: space.sm }}>
        Recent activity
      </Txt>
      {txns.isLoading ? (
        <Card>
          <Loading />
        </Card>
      ) : (txns.data?.length ?? 0) === 0 ? (
        <Card style={{ paddingVertical: space.xl }}>
          <EmptyState
            title="No transactions yet"
            subtitle="Delivery earnings and customer tips will show up here."
          />
        </Card>
      ) : (
        <Card>
          {txns.data!.map((t, i) => (
            <View key={t.id}>
              {i > 0 ? <Divider /> : null}
              <TxnRow txn={t} />
            </View>
          ))}
        </Card>
      )}
    </ScrollView>
  );
}

const CREDIT_TYPES: TxnType[] = ["CREDIT", "ADJUSTMENT"];
const txnLabel: Record<TxnType, string> = {
  CREDIT: "Delivery earning",
  DEBIT: "Debit",
  PAYOUT: "Payout",
  ADJUSTMENT: "Adjustment",
};

function TxnRow({ txn }: { txn: WalletTxn }) {
  const isCredit = CREDIT_TYPES.includes(txn.type);
  const isTip = isTipTxn(txn);
  const title = txn.note ?? txnLabel[txn.type];
  return (
    <View
      accessible
      accessibilityLabel={`${title}, ${isCredit ? "credited" : "debited"} ${rupees(
        txn.amountPaise,
      )}, ${dateTime(txn.createdAt)}. Balance ${rupees(txn.balanceAfterPaise)}`}
      style={{ paddingVertical: space.sm }}
    >
      <Row style={{ justifyContent: "space-between" }}>
        <View style={{ flex: 1, gap: space.xs }}>
          <Row gap={space.sm}>
            <Txt weight="600" style={{ flexShrink: 1 }}>
              {title}
            </Txt>
            {isTip ? <Badge label="TIP" tone="success" /> : null}
          </Row>
          <Txt color="faint" size={font.xs}>
            {dateTime(txn.createdAt)}
          </Txt>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Txt color={isCredit ? "success" : "danger"} weight="800">
            {isCredit ? "+" : "−"}
            {rupees(txn.amountPaise)}
          </Txt>
          <Txt color="faint" size={font.xs}>
            bal {rupees(txn.balanceAfterPaise)}
          </Txt>
        </View>
      </Row>
    </View>
  );
}
