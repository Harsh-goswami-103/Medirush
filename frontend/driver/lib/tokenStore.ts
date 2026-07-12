import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Persisted session bearer (audit P3). Primary store: expo-secure-store
 * (Android Keystore / iOS Keychain) so the token is no longer plaintext on
 * disk. AsyncStorage remains ONLY as a fallback where SecureStore's native
 * module is absent (Expo Go / the pre-Firebase dev client / web); an existing
 * AsyncStorage token is migrated to SecureStore once, then the plaintext copy
 * is deleted.
 *
 * expo-secure-store throws at import time when its native module is missing
 * (`requireNativeModule('ExpoSecureStore')`), so — like lib/firebase.ts — it is
 * lazy-required and probed inside try/catch.
 */

const TOKEN_KEY = "medrush.driver.token";

type SecureStoreModule = typeof import("expo-secure-store");

/* Metro provides CommonJS `require` at runtime; declare it for tsc (no
 * @types/node in this app). */
declare const require: (id: string) => unknown;

/** Cached probe — `undefined` = not probed yet, `null` = unavailable. */
let cachedSecureStore: SecureStoreModule | null | undefined;

async function getSecureStore(): Promise<SecureStoreModule | null> {
  if (cachedSecureStore !== undefined) return cachedSecureStore;
  try {
    const mod = require("expo-secure-store") as SecureStoreModule;
    cachedSecureStore = (await mod.isAvailableAsync()) ? mod : null;
  } catch {
    cachedSecureStore = null;
  }
  return cachedSecureStore;
}

/** Read the persisted bearer, migrating a legacy AsyncStorage token once. */
export async function readStoredToken(): Promise<string | null> {
  const secure = await getSecureStore();
  if (secure) {
    try {
      const stored = await secure.getItemAsync(TOKEN_KEY);
      if (stored) return stored;
      // One-time migration from the legacy plaintext AsyncStorage slot.
      const legacy = await AsyncStorage.getItem(TOKEN_KEY);
      if (legacy) {
        await secure.setItemAsync(TOKEN_KEY, legacy);
        await AsyncStorage.removeItem(TOKEN_KEY).catch(() => undefined);
        return legacy;
      }
      return null;
    } catch {
      // Keystore hiccup — fall through to AsyncStorage below.
    }
  }
  return AsyncStorage.getItem(TOKEN_KEY).catch(() => null);
}

export async function writeStoredToken(token: string): Promise<void> {
  const secure = await getSecureStore();
  if (secure) {
    try {
      await secure.setItemAsync(TOKEN_KEY, token);
      // SecureStore is now the single source of truth — drop any stale
      // AsyncStorage fallback copy so a later keystore read hiccup can never
      // resurrect an older token.
      await AsyncStorage.removeItem(TOKEN_KEY).catch(() => undefined);
      return;
    } catch {
      // Keystore hiccup — fall through so the driver stays signed in. Delete
      // the (possibly stale) SecureStore slot first: readStoredToken prefers
      // SecureStore, so a leftover old token there would shadow the fresh one
      // written to AsyncStorage below.
      await secure.deleteItemAsync(TOKEN_KEY).catch(() => undefined);
    }
  }
  await AsyncStorage.setItem(TOKEN_KEY, token).catch(() => undefined);
}

export async function clearStoredToken(): Promise<void> {
  const secure = await getSecureStore();
  if (secure) await secure.deleteItemAsync(TOKEN_KEY).catch(() => undefined);
  // Clear the legacy slot too (pre-migration installs).
  await AsyncStorage.removeItem(TOKEN_KEY).catch(() => undefined);
}
