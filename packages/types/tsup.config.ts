import { defineConfig } from "tsup"

export default defineConfig({
  // Source-only exports get declarations from tsc. Emit JavaScript only for
  // exports whose production runtime target lives in dist.
  entry: {
    "google-drive-upload": "src/google-drive-upload.ts",
    "managed-provider-config": "src/managed-provider-config.ts",
    "cloud-model-fast": "src/cloud-model-fast.ts",
    "mcp-app-timing": "src/mcp-app-timing.ts",
    "connection-action-app": "src/connection-action-app.ts",
    "den/desktop-policies": "src/den/desktop-policies.ts",
    "den/policy-rules": "src/den/policy-rules.ts",
    "den/agent-permissions": "src/den/agent-permissions.ts",
    "den/gateway": "src/den/gateway.ts",
    "den/gateway-usage-limits": "src/den/gateway-usage-limits.ts",
  },
  tsconfig: "./tsconfig.json",
  format: ["esm"],
  dts: false,
  clean: true,
  target: "es2022",
  platform: "neutral",
  sourcemap: false,
  splitting: false,
  treeshake: true,
  external: ["zod"],
})
