/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TS source; Next must transpile them.
  transpilePackages: ["@medrush/contracts", "@medrush/ui"],
  // Lint runs as its own pipeline step (turbo `lint`), not inside the build.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
