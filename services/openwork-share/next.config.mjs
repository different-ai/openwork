import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(rootDir, "../..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: workspaceRoot
  },
  async rewrites() {
    return [
      { source: "/health", destination: "/api/health" },
      { source: "/og/:path*", destination: "/api/og/:path*" },
      { source: "/v1/:path*", destination: "/api/v1/:path*" }
    ];
  }
};

export default nextConfig;
