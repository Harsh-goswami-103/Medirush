/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TS source; Next must transpile them.
  transpilePackages: ["@medrush/contracts", "@medrush/ui"],
  // Lint runs as its own pipeline step (turbo `lint`), not inside the build.
  eslint: { ignoreDuringBuilds: true },
  // Readable Sentry stack traces, same call as web's launch-audit decision —
  // and lower-risk here: ops sits behind the Cloudflare IN geo-lock. Revisit
  // with an upload-then-delete (sentry-cli) flow if source exposure becomes
  // a concern.
  productionBrowserSourceMaps: true,
};

export default nextConfig;
