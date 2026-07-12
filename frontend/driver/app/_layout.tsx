import { useEffect } from "react";
import {
  Stack,
  useNavigationContainerRef,
  useRouter,
  useSegments,
  type ErrorBoundaryProps,
} from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { View } from "react-native";
import * as Sentry from "@sentry/react-native";
// Side-effect import: registers the background-location TaskManager task at
// module scope (a TaskManager requirement — see lib/backgroundLocation.ts).
import "@/lib/backgroundLocation";
import { AuthProvider, useAuth } from "@/lib/auth";
import { DispatchProvider } from "@/lib/dispatch";
import { DutyProvider } from "@/lib/duty";
import { usePushRegistration } from "@/lib/notifications";
import { QueryProvider } from "@/lib/query";
import { Button, Loading, Txt } from "@/components/ui";
import { colors, font, space } from "@/lib/theme";
import { initSentry, navigationIntegration } from "@/lib/sentry";

// Initialise crash/error reporting before the tree mounts (no-op without a DSN).
initSentry();

/**
 * Root layout: providers (query → auth → dispatch) + an auth gate that keeps the
 * driver on `/login` until signed in, and out of it once signed in. Screens live
 * in the `(tabs)` group; the active-delivery and payout screens push over them.
 */

/**
 * Render fallback for uncaught render errors below the root layout (expo-router
 * picks up this export). Sentry.wrap instruments; this gives the driver a
 * branded recovery screen instead of a white crash, and reports the error.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.bg,
        alignItems: "center",
        justifyContent: "center",
        padding: space.xl,
        gap: space.md,
      }}
    >
      <Txt size={font.xl} weight="800" align="center">
        Something went wrong
      </Txt>
      <Txt color="muted" align="center">
        MedRush hit an unexpected error. Your shift and deliveries are safe — tap below to
        reload.
      </Txt>
      <Button
        title="Try again"
        onPress={() => void retry()}
        style={{ alignSelf: "stretch", marginTop: space.md }}
      />
    </View>
  );
}

function RootNavigator() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // Register this device for FCM push once signed in (no-op in the old dev
  // client / without google-services.json — see lib/notifications.ts).
  usePushRegistration(!!user);

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
