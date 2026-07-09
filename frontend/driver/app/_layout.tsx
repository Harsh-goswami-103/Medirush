import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { View } from "react-native";
import { AuthProvider, useAuth } from "@/lib/auth";
import { DispatchProvider } from "@/lib/dispatch";
import { DutyProvider } from "@/lib/duty";
import { QueryProvider } from "@/lib/query";
import { Loading } from "@/components/ui";
import { colors } from "@/lib/theme";

/**
 * Root layout: providers (query → auth → dispatch) + an auth gate that keeps the
 * driver on `/login` until signed in, and out of it once signed in. Screens live
 * in the `(tabs)` group; the active-delivery and payout screens push over them.
 */

function RootNavigator() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    const onLogin = segments[0] === "login";
    if (!user && !onLogin) router.replace("/login");
    else if (user && onLogin) router.replace("/");
  }, [user, loading, segments, router]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Loading label="Starting shift…" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="active" options={{ presentation: "card" }} />
      <Stack.Screen name="payout" options={{ presentation: "modal" }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <QueryProvider>
        <AuthProvider>
          <DutyProvider>
            <DispatchProvider>
              <RootNavigator />
            </DispatchProvider>
          </DutyProvider>
        </AuthProvider>
      </QueryProvider>
    </SafeAreaProvider>
  );
}
