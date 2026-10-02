import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { readAsset } from "../src/assets.ts";

const src = new URL("../src/", import.meta.url);

test("files resolved against import.meta.url are string literals, never computed paths", async () => {
  // Turbopack (review app) compiles a computed `new URL(expr, import.meta.url)` to one
  // fixed file, so every script written into preview VMs became the same file.
  const offenders: string[] = [];
  for (const name of await readdir(src)) {
    if (!/\.(ts|mjs)$/.test(name)) continue;
    const text = await readFile(new URL(name, src), "utf8");
    for (const match of text.matchAll(/new URL\(([^,()]+),\s*import\.meta\.url\)/g)) {
      if (!/^\s*["'][^"'`$]+["']\s*$/.test(match[1])) offenders.push(`${name}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("every controller asset resolves to its own file", async () => {
  for (const name of ["runtime.mjs", "acme-runtime.mjs", "desktop-runtime.mjs", "gateway.mjs", "builder.ts"] as const) {
    assert.equal(await readAsset(name), await readFile(new URL(name, src), "utf8"), name);
  }
});
