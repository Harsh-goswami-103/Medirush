import { Tabs } from "expo-router";
import { Text } from "react-native";
import { colors, space } from "@/lib/theme";

/** Bottom-tab shell (Home / Wallet / History / Profile), dark themed. */
const icon =
  (emoji: string) =>
  ({ focused }: { focused: boolean }) => (
    <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.5 }}>{emoji}</Text>
  );

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          height: 64,
          paddingTop: space.xs,
          paddingBottom: space.sm,
        },
        tabBarLabelStyle: { fontSize: 12, fontWeight: "600" },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Home", tabBarIcon: icon("🛵") }} />
      <Tabs.Screen name="wallet" options={{ title: "Wallet", tabBarIcon: icon("💰") }} />
      <Tabs.Screen name="history" options={{ title: "History", tabBarIcon: icon("📋") }} />
      <Tabs.Screen name="profile" options={{ title: "Profile", tabBarIcon: icon("👤") }} />
    </Tabs>
  );
}
