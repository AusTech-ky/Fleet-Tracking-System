/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle for the production Docker image.
  output: 'standalone',
  // Keep the build self-contained and lint-independent for CI here.
  eslint: { ignoreDuringBuilds: true },
  // This app has its own lockfile; pin the tracing root to silence the warning.
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;
