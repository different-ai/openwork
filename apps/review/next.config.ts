import { resolve } from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  transpilePackages: ["@openwork/review", "@openwork/evidence-provider", "@openwork/evidence-daytona", "@openwork/world-freestyle"],
  outputFileTracingIncludes: { "/*": ["../../packages/world-freestyle/src/*.mjs", "../../packages/world-freestyle/src/builder.ts", "../../packages/world-freestyle/src/cache.ts", "../../packages/world-freestyle/src/build-recipes.ts"] },
};
export default config;
