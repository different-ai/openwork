import { resolve } from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  transpilePackages: ["@openwork/review", "@openwork/evidence-provider", "@openwork/evidence-daytona", "@openwork/evidence-freestyle"],
  outputFileTracingIncludes: { "/*": ["../../packages/evidence-freestyle/src/*.mjs", "../../packages/evidence-freestyle/src/builder.ts", "../../packages/evidence-freestyle/src/cache.ts", "../../packages/evidence-freestyle/src/build-recipes.ts"] },
};
export default config;
