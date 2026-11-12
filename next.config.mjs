/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root: import.meta.dirname },
  // the engine spawns child processes and reads arbitrary project files at runtime; keep it out of the bundler
  serverExternalPackages: ["@babel/parser", "playwright-core", "@playwright/test", "axe-core"],
};
export default nextConfig;
