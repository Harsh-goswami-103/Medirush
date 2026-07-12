// Dynamic Expo config (replaces app.json — every static field preserved).
//
// Why dynamic: the @react-native-firebase/app config plugin REQUIRES
// android.googleServicesFile to resolve at prebuild time — listing the plugin
// while google-services.json is absent fails every EAS build. The operator
// provisions google-services.json (gitignored — NEVER commit it); until then
// the RNFirebase plugins are omitted and builds keep working. At runtime the
// app probes for the native module (lib/firebase.ts): present → phone-OTP
// login; absent → dev-token login in dev builds, or a loud "sign-in is not
// configured" screen in release builds.
//
// iOS note: an iOS build with Firebase additionally needs
// GoogleService-Info.plist + ios.googleServicesFile (Android-first for launch).
const fs = require("fs");
const path = require("path");

const hasGoogleServices = fs.existsSync(path.join(__dirname, "google-services.json"));

/** Single source for the EAS project id (consumed by extra.eas + updates.url). */
const easProjectId = "a9eb6601-f3fc-4c41-96bf-6b1443f29a70";

module.exports = {
  expo: {
    name: "MedRush Driver",
    slug: "medrush-driver",
    scheme: "medrushdriver",
    // Launch version — the backend 426-gates /v1/driver/* on x-app-version with
    // StoreConfig.minDriverAppVersion defaulting to "1.0.0" (lib/env.ts derives
    // the runtime header from this field via expo-constants).
    version: "1.0.0",
    // OTA updates (EAS Update): runtime keyed to the app version so a JS update
    // never lands on a binary missing its native modules. Channels live in
    // eas.json (preview/production); the development profile uses the dev server.
    runtimeVersion: { policy: "appVersion" },
    updates: {
      url: `https://u.expo.dev/${easProjectId}`,
    },
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "dark",
    backgroundColor: "#0B1220",
    newArchEnabled: true,
    splash: {
      image: "./assets/splash-icon.png",
      resizeMode: "contain",
      backgroundColor: "#0B1220",
    },
    assetBundlePatterns: ["**/*"],
    android: {
      package: "in.medrush.driver",
      // versionCode is managed remotely by EAS (eas.json appVersionSource
      // "remote" + production autoIncrement) — this local value is ignored.
      versionCode: 1,
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#0D9488",
      },
      permissions: [
        "ACCESS_FINE_LOCATION",
        "ACCESS_COARSE_LOCATION",
        // Live tracking while the phone is pocketed during an active delivery
        // (lib/backgroundLocation.ts — foreground-service location updates).
        "ACCESS_BACKGROUND_LOCATION",
        "FOREGROUND_SERVICE",
        "FOREGROUND_SERVICE_LOCATION",
        "POST_NOTIFICATIONS",
        "VIBRATE",
        "WAKE_LOCK",
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.ACCESS_FINE_LOCATION",
      ],
      ...(hasGoogleServices ? { googleServicesFile: "./google-services.json" } : {}),
    },
    ios: {
      supportsTablet: false,
      bundleIdentifier: "in.medrush.driver",
      infoPlist: {
        UIBackgroundModes: ["location", "fetch"],
      },
    },
    web: {
      favicon: "./assets/favicon.png",
    },
    plugins: [
      "expo-router",
      [
        "expo-location",
        {
          locationAlwaysAndWhenInUsePermission:
            "MedRush needs your location while you are online to receive nearby delivery offers and share live position with customers.",
        },
      ],
      "@sentry/react-native",
      "expo-secure-store",
      ...(hasGoogleServices ? ["@react-native-firebase/app", "@react-native-firebase/auth"] : []),
    ],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      router: {},
      eas: {
        projectId: easProjectId,
      },
    },
    owner: "harshgoswami",
  },
};
