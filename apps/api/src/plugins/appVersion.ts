import type { FastifyPluginAsync } from "fastify";
import { AppError } from "../core/errors";
import { asGlobalPlugin } from "../core/plugin-utils";
import { getStoreConfig } from "../core/storeInfo";

/**
 * 426 UPGRADE_REQUIRED gate (§7.1): every `/v1/driver/*` request must carry an
 * `x-app-version` header at or above `StoreConfig.minDriverAppVersion`.
 * A missing or malformed header counts as below-minimum — old clients can
 * never speak a stale contract. Registered BEFORE the auth plugin so outdated
 * apps see 426 (blocking update screen) rather than 401.
 *
 * The prefix check uses the raw URL, not the matched route: an old client
 * calling a removed driver endpoint should also be told to upgrade, not 404.
 */

type Semver = [major: number, minor: number, patch: number];

function parseSemver(value: string): Semver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  const [, major = "", minor = "", patch = ""] = match;
  return [Number(major), Number(minor), Number(patch)];
}

function isBelow(version: Semver, min: Semver): boolean {
  for (let i = 0; i < 3; i += 1) {
    const a = version[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

export const appVersionPlugin: FastifyPluginAsync = asGlobalPlugin(async (app) => {
  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (!path.startsWith("/v1/driver/")) return;

    let minRaw: string;
    try {
      minRaw = (await getStoreConfig()).minDriverAppVersion;
    } catch (error) {
      if (error instanceof AppError && error.code === "STORE_CONFIG_MISSING") {
        // No minimum is defined on an unseeded database — fail open rather
        // than 500 every driver request (production is always seeded).
        request.log.warn("appVersion gate skipped: StoreConfig row missing");
        return;
      }
      throw error;
    }

    const min = parseSemver(minRaw);
    if (!min) {
      request.log.warn({ minDriverAppVersion: minRaw }, "appVersion gate skipped: bad semver in StoreConfig");
      return;
    }

    const headerRaw = request.headers["x-app-version"];
    const headerValue = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
    const version = headerValue === undefined ? null : parseSemver(headerValue);

    if (version === null || isBelow(version, min)) {
      throw new AppError(
        "UPGRADE_REQUIRED",
        `Driver app version ${headerValue ?? "(missing)"} is below the required minimum ${minRaw} — please update the app`,
        426,
        { minDriverAppVersion: minRaw },
      );
    }
  });
});
