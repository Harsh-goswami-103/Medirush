#!/usr/bin/env node
/**
 * Production-dependency audit against npm's bulk advisory endpoint.
 *
 * Stopgap for `pnpm audit --prod --audit-level=high`: npm permanently retired
 * the classic audit endpoints on 2026-07-15 (HTTP 410, pnpm/pnpm#11265), and
 * no released pnpm queries the replacement yet (the fix, pnpm/pnpm#11268, is
 * merged but unshipped as of 11.13.0). Delete this file and restore the plain
 * `pnpm audit` CI step once a pnpm release ships it.
 *
 * Behaviour mirrors the old gate:
 *  - prod dependency graph only (resolved by pnpm itself via `pnpm ls`, not by
 *    hand-rolled lockfile traversal), workspace-wide;
 *  - fails (exit 1) only on high/critical advisories.
 *
 * The bulk endpoint pre-filters by the submitted versions — an advisory comes
 * back only when a submitted version is inside its vulnerable range (verified
 * empirically: lodash@4.17.11 returns its high/critical set, lodash@4.17.21
 * only a moderate one) — so no client-side semver matching is needed.
 * Requires installed node_modules (`pnpm install --frozen-lockfile`).
 */
import { execSync } from "node:child_process";

const BULK_URL = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
const FAIL_SEVERITIES = new Set(["high", "critical"]);
const CHUNK = 500; // package names per request — keeps bodies comfortably small

/** name → Set<version>, from every workspace importer's prod graph. */
function collectProdPackages() {
  const json = execSync("pnpm ls -r --prod --depth Infinity --json", {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const importers = JSON.parse(json);
  const pkgs = new Map();
  function walk(deps) {
    if (!deps) return;
    for (const [name, info] of Object.entries(deps)) {
      // Skip workspace links; strip pnpm's peer-dep suffix "1.2.3(peer@x)".
      if (info.version && !info.version.startsWith("link:")) {
        const version = info.version.split("(")[0];
        if (!pkgs.has(name)) pkgs.set(name, new Set());
        pkgs.get(name).add(version);
      }
      walk(info.dependencies);
    }
  }
  for (const importer of importers) {
    walk(importer.dependencies);
    walk(importer.optionalDependencies);
  }
  return pkgs;
}

async function queryAdvisories(pkgs) {
  const names = [...pkgs.keys()];
  const findings = [];
  for (let i = 0; i < names.length; i += CHUNK) {
    const body = {};
    for (const name of names.slice(i, i + CHUNK)) body[name] = [...pkgs.get(name)];
    const res = await fetch(BULK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Bulk advisory endpoint responded ${res.status}: ${await res.text()}`);
    }
    const advisories = await res.json();
    for (const [name, list] of Object.entries(advisories)) {
      for (const adv of list) {
        findings.push({ name, versions: [...pkgs.get(name)].join(", "), ...adv });
      }
    }
  }
  return findings;
}

const pkgs = collectProdPackages();
const findings = await queryAdvisories(pkgs);
const failing = findings.filter((f) => FAIL_SEVERITIES.has(f.severity));
const ignored = findings.length - failing.length;

console.log(
  `Audited ${pkgs.size} production packages: ` +
    `${failing.length} high/critical, ${ignored} below threshold.`,
);
for (const f of failing) {
  console.error(
    `\n[${f.severity.toUpperCase()}] ${f.name} (installed: ${f.versions})\n` +
      `  ${f.title}\n  vulnerable: ${f.vulnerable_versions}\n  ${f.url}`,
  );
}
if (failing.length > 0) process.exit(1);
