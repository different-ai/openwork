#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const assetsDirectory = resolve(root, "apps/app/dist/assets");

if (!existsSync(assetsDirectory)) {
  throw new Error("apps/app/dist/assets is missing; build @openwork/app before verifying Markdown CSS");
}

const css = readdirSync(assetsDirectory)
  .filter((path) => path.endsWith(".css"))
  .map((path) => readFileSync(resolve(assetsDirectory, path), "utf8"))
  .join("\n");

const requiredSelectors = [
  "rounded-\\[18px\\]",
  "border-dls-border\\/70",
  "bg-gray-1\\/80",
  "text-indigo-8",
  "bg-amber-4\\/70",
  "via-background\\/90",
  "list-decimal",
];
const missing = requiredSelectors.filter((selector) => !css.includes(selector));

if (missing.length > 0) {
  throw new Error(`Markdown production CSS is missing package-owned selectors: ${missing.join(", ")}`);
}

process.stdout.write(`${JSON.stringify({ ok: true, selectors: requiredSelectors }, null, 2)}\n`);
