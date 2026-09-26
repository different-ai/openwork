import { readFile } from "node:fs/promises";

/**
 * Files the controller hashes into cache keys or copies into guest VMs.
 *
 * Every entry must stay a literal `new URL("./file", import.meta.url)`. The review
 * app bundles this package with Turbopack, which resolves each literal to its own
 * asset but compiled a computed path (a template string built from a file name) to
 * one fixed file: every script written into preview VMs became browser-health.mjs,
 * so builds started from the review app booted nothing. test/assets.test.ts
 * rejects computed paths anywhere in src/.
 */
const assets = {
  "acme-runtime.mjs": new URL("./acme-runtime.mjs", import.meta.url),
  "browser-health.mjs": new URL("./browser-health.mjs", import.meta.url),
  "browser-recipe.ts": new URL("./browser-recipe.ts", import.meta.url),
  "build-recipes.ts": new URL("./build-recipes.ts", import.meta.url),
  "builder.ts": new URL("./builder.ts", import.meta.url),
  "cache.ts": new URL("./cache.ts", import.meta.url),
  "desktop-health.mjs": new URL("./desktop-health.mjs", import.meta.url),
  "desktop-refresh.mjs": new URL("./desktop-refresh.mjs", import.meta.url),
  "desktop-runtime.mjs": new URL("./desktop-runtime.mjs", import.meta.url),
  "desktop-state.mjs": new URL("./desktop-state.mjs", import.meta.url),
  "desktop.mjs": new URL("./desktop.mjs", import.meta.url),
  "evidence-control.mjs": new URL("./evidence-control.mjs", import.meta.url),
  "evidence-runtime.mjs": new URL("./evidence-runtime.mjs", import.meta.url),
  "gateway.mjs": new URL("./gateway.mjs", import.meta.url),
  "health.mjs": new URL("./health.mjs", import.meta.url),
  "origins.mjs": new URL("./origins.mjs", import.meta.url),
  "refresh.mjs": new URL("./refresh.mjs", import.meta.url),
  "resume.mjs": new URL("./resume.mjs", import.meta.url),
  "runtime.mjs": new URL("./runtime.mjs", import.meta.url),
};

export type ControllerAsset = keyof typeof assets;

export function readAsset(name: ControllerAsset): Promise<string> {
  return readFile(assets[name], "utf8");
}
