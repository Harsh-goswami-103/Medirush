// Autolinking override (pnpm monorepo fix).
//
// expo-modules-autolinking's `react-native-config` generator can fail to apply
// the `expo` package's own react-native.config.js in a pnpm workspace (its
// `findProjectRootSync()` resolves the wrong root, so `isExpoModulesInstalledAndroid`
// returns false → the android config becomes null). The Android resolver then
// SYNTHESISES the package import from the android namespace, producing the
// legacy `import expo.core.ExpoModulesPackage;` — a class that no longer exists
// (it's `expo.modules.ExpoModulesPackage` since SDK 45), breaking
// `:app:compileDebugJavaWithJavac` with "cannot find symbol".
//
// Project-level `dependencies` overrides are shallow-merged OVER the library
// config (expo-modules-autolinking/build/reactNativeConfig/reactNativeConfig.js),
// so pinning the correct import path here fixes the generated PackageList.java.
module.exports = {
  dependencies: {
    expo: {
      platforms: {
        android: {
          packageImportPath: "import expo.modules.ExpoModulesPackage;",
        },
      },
    },
  },
};
