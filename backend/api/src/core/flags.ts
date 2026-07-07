import { getPrisma } from "./db";

/**
 * Feature flags & tunables over the `AppSetting` table (§5, §12).
 * Typed accessor with a 60s in-process cache; Admin ▸ Settings saves call
 * `bustFlagCache()` (Phase 3) so edits are visible within one request.
 *
 * Launch flags (§5): cod_enabled, rx_orders_enabled, dispatch_wave_size,
 * new_account_cod_cap, maintenance_banner.
 */

const CACHE_TTL_MS = 60_000;

/** Sentinel for "no AppSetting row" — caches the miss without inventing a value. */
const MISSING = Symbol("flag-missing");

const cache = new Map<string, { value: unknown; expiresAt: number }>();

/**
 * Read a flag by key, falling back to `defaultValue` when the row is absent
 * (or its JSON value is null). The stored JSON is trusted to match `T` —
 * flags are written by trusted admin surfaces, not clients.
 */
export async function getFlag<T>(key: string, defaultValue: T): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value === MISSING ? defaultValue : (hit.value as T);
  }

  const row = await getPrisma().appSetting.findUnique({ where: { key } });
  const value: unknown = row === null || row.value === null ? MISSING : row.value;
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  return value === MISSING ? defaultValue : (value as T);
}

/** Bust one flag (settings save) or the whole cache (tests). */
export function bustFlagCache(key?: string): void {
  if (key === undefined) {
    cache.clear();
  } else {
    cache.delete(key);
  }
}
