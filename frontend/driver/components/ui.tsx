import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import { colors, font, HIT_HEIGHT, radius, space } from "@/lib/theme";

/**
 * Dark, high-contrast component kit for the driver app (BLUEPRINT §20). Every
 * touch target is ≥ 56px; text defaults to the light-on-dark palette. Screens
 * compose these — no raw hex or magic numbers in feature code.
 */

/* --------------------------------------------------------------- layout */

export function Screen({
  children,
  scroll = false,
  edges = ["top", "bottom"],
  contentStyle,
}: {
  children: ReactNode;
  scroll?: boolean;
  edges?: readonly Edge[];
  contentStyle?: StyleProp<ViewStyle>;
}) {
  return (
    <SafeAreaView style={styles.screen} edges={edges}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={[styles.screenPad, contentStyle]}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.screenPad, styles.flex, contentStyle]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

export function Card({
  children,
  style,
  tone = "surface",
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  tone?: "surface" | "alt";
}) {
  return (
    <View
      style={[styles.card, tone === "alt" && { backgroundColor: colors.surfaceAlt }, style]}
    >
      {children}
    </View>
  );
}

export function Row({
  children,
  style,
  gap = space.md,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  gap?: number;
}) {
  return <View style={[styles.row, { gap }, style]}>{children}</View>;
}

export function Divider() {
  return <View style={styles.divider} />;
}

/* ----------------------------------------------------------------- text */

type TxtColor = keyof typeof txtColorMap;
const txtColorMap = {
  text: colors.text,
  muted: colors.textMuted,
  faint: colors.textFaint,
  primary: colors.primary,
  danger: colors.danger,
  success: colors.success,
  cash: colors.cash,
  warning: colors.warning,
};

export function Txt({
  children,
  size = font.base,
  color = "text",
  weight = "400",
  align,
  style,
  numberOfLines,
}: {
  children: ReactNode;
  size?: number;
  color?: TxtColor;
  weight?: TextStyle["fontWeight"];
  align?: TextStyle["textAlign"];
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[{ color: txtColorMap[color], fontSize: size, fontWeight: weight, textAlign: align }, style]}
    >
      {children}
    </Text>
  );
}

export function H1({ children }: { children: ReactNode }) {
  return <Txt size={font.xxl} weight="800">{children}</Txt>;
}
export function H2({ children }: { children: ReactNode }) {
  return <Txt size={font.lg} weight="700">{children}</Txt>;
}

/* --------------------------------------------------------------- button */

type ButtonVariant = "primary" | "danger" | "success" | "ghost" | "subtle";

export function Button({
  title,
  onPress,
  variant = "primary",
  size = "md",
  loading = false,
  disabled = false,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: "md" | "lg" | "sm";
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const isDisabled = disabled || loading;
  const height = size === "lg" ? 72 : size === "sm" ? 44 : HIT_HEIGHT;
  const v = buttonVariants[variant];
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        { height, backgroundColor: v.bg, borderColor: v.border },
        pressed && !isDisabled && { backgroundColor: v.pressed },
        isDisabled && styles.buttonDisabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={v.fg} />
      ) : (
        <Text style={[styles.buttonText, { color: v.fg, fontSize: size === "lg" ? font.xl : font.base }]}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}

const buttonVariants: Record<
  ButtonVariant,
  { bg: string; pressed: string; fg: string; border: string }
> = {
  primary: { bg: colors.primary, pressed: colors.primaryPressed, fg: colors.onPrimary, border: colors.primary },
  danger: { bg: colors.danger, pressed: colors.dangerPressed, fg: "#1A0A0B", border: colors.danger },
  success: { bg: colors.success, pressed: "#16A34A", fg: "#04140A", border: colors.success },
  ghost: { bg: "transparent", pressed: colors.surfaceAlt, fg: colors.text, border: colors.border },
  subtle: { bg: colors.surfaceAlt, pressed: colors.border, fg: colors.text, border: colors.border },
};

/* ---------------------------------------------------------------- badge */

export function Badge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "success" | "danger" | "warning" | "info";
}) {
  const map = {
    neutral: { bg: colors.surfaceAlt, fg: colors.textMuted },
    success: { bg: colors.successBg, fg: colors.success },
    danger: { bg: colors.dangerBg, fg: colors.danger },
    warning: { bg: colors.warningBg, fg: colors.warning },
    info: { bg: "#0C2233", fg: colors.info },
  }[tone];
  return (
    <View style={[styles.badge, { backgroundColor: map.bg }]}>
      <Text style={[styles.badgeText, { color: map.fg }]}>{label}</Text>
    </View>
  );
}

/* ---------------------------------------------------------------- field */

export function Field({
  label,
  hint,
  style,
  ...props
}: TextInputProps & { label?: string; hint?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.field, style]}>
      {label ? <Txt size={font.sm} color="muted" weight="600">{label}</Txt> : null}
      <TextInput
        placeholderTextColor={colors.textFaint}
        style={styles.input}
        {...props}
      />
      {hint ? <Txt size={font.xs} color="faint">{hint}</Txt> : null}
    </View>
  );
}

/* ----------------------------------------------------------- feedback */

export function Loading({ label }: { label?: string }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.primary} size="large" />
      {label ? <Txt color="muted" style={{ marginTop: space.md }}>{label}</Txt> : null}
    </View>
  );
}

export function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.center}>
      <Txt size={font.lg} weight="700" align="center">{title}</Txt>
      {subtitle ? (
        <Txt color="muted" align="center" style={{ marginTop: space.sm }}>{subtitle}</Txt>
      ) : null}
    </View>
  );
}

export function StatCard({ label, value, tone = "text" }: { label: string; value: string; tone?: TxtColor }) {
  return (
    <Card style={styles.statCard}>
      <Txt size={font.sm} color="muted" weight="600">{label}</Txt>
      <Txt size={font.xl} weight="800" color={tone} style={{ marginTop: space.xs }}>{value}</Txt>
    </Card>
  );
}

/* --------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  screenPad: { padding: space.lg, gap: space.md },
  flex: { flex: 1 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: space.lg,
  },
  row: { flexDirection: "row", alignItems: "center" },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: space.sm },
  button: {
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.lg,
  },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { fontWeight: "800" },
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
  },
  badgeText: { fontSize: font.xs, fontWeight: "700" },
  field: { gap: space.xs },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: font.base,
    paddingHorizontal: space.md,
    height: HIT_HEIGHT,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  statCard: { flex: 1, padding: space.md },
});
