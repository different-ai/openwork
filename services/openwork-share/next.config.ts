import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const rootDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(rootDir, "../..");

const nextConfig: NextConfig = {
  turbopack: {
    root: workspaceRoot
  },
  async rewrites() {
    return [
      { source: "/health", destination: "/api/health" },
      { source: "/v1/:path*", destination: "/api/v1/:path*" }
    ];
  }
};

export default nextConfig;
