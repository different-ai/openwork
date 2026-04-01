import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
};

export default nextConfig;
