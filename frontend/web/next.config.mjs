import createNextIntlPlugin from "next-intl/plugin";

// Routing-free next-intl: the locale comes from a cookie (src/i18n/request.ts),
// so URLs are unchanged and the PWA's start_url keeps working.
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TS source; Next must transpile them.
  transpilePackages: ["@medrush/contracts", "@medrush/ui"],
  // Lint runs as its own pipeline step (turbo `lint`), not inside the build.
  eslint: { ignoreDuringBuilds: true },
  // Readable Sentry stack traces. The maps are served publicly — accepted per
  // the launch audit (traffic sits behind Cloudflare); revisit later with an
  // upload-then-delete (sentry-cli) flow if source exposure becomes a concern.
  productionBrowserSourceMaps: true,
};

export default withNextIntl(nextConfig);
