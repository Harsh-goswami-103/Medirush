import { useEffect } from "react";
import { Stack, useNavigationContainerRef, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { View } from "react-native";
import * as Sentry from "@sentry/react-native";
import { AuthProvider, useAuth } from "@/lib/auth";
import { DispatchProvider } from "@/lib/dispatch";
import { DutyProvider } from "@/lib/duty";
import { QueryProvider } from "@/lib/query";
import { Loading } from "@/components/ui";
import { colors } from "@/lib/theme";
import { initSentry, navigationIntegration } from "@/lib/sentry";

// Initialise crash/error reporting before the tree mounts (no-op without a DSN).
initSentry();

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

function RootLayout() {
  // Register the navigation container so Sentry can trace route transitions.
  const navRef = useNavigationContainerRef();
  useEffect(() => {
    if (navRef?.current) navigationIntegration.registerNavigationContainer(navRef);
  }, [navRef]);

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

// Sentry.wrap adds the error boundary + touch/navigation instrumentation.
export default Sentry.wrap(RootLayout);
