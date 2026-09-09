import { resolve } from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  transpilePackages: ["@openwork/review"],
};
export default config;
