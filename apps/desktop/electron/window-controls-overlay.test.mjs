import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { titleBarOverlayForTheme } from "./window-controls-overlay.mjs";

test("colors the caption buttons like the dark header", () => {
  assert.deepEqual(titleBarOverlayForTheme({ shouldUseDarkColors: true }), {
    color: "#111113",
    symbolColor: "#edeef0",
    height: 40,
  });
});

test("colors the caption buttons like the light header", () => {
  assert.deepEqual(titleBarOverlayForTheme({ shouldUseDarkColors: false }), {
    color: "#fcfcfd",
    symbolColor: "#1c2024",
    height: 40,
  });
});

test("stays in sync with the renderer's header tokens", () => {
  // The main process cannot read renderer CSS, so a palette change must fail
  // here instead of bringing back a mismatched block beside the title bar.
  const tokens = readFileSync(new URL("../../app/src/app/index.css", import.meta.url), "utf8");
  const values = (name) => [...tokens.matchAll(new RegExp(`${name}:\\s*([^;]+);`, "g"))].map((match) => match[1]);
  const surfaces = values("--dls-surface");
  const texts = values("--dls-text-primary");
  assert.ok(surfaces.length > 0 && surfaces.every((value) => value === "var(--slate-1)"));
  assert.ok(texts.length > 0 && texts.every((value) => value === "var(--slate-12)"));

  // sRGB values: the top-level :root palette, then the top-level dark palette.
  // The display-p3 overrides between them use color() rather than hex.
  const palette = readFileSync(new URL("../../app/src/styles/colors.css", import.meta.url), "utf8");
  const darkStart = palette.search(/^\[data-theme="dark"\] \{$/m);
  assert.notEqual(darkStart, -1);
  const slate = (block, step) => block.match(new RegExp(`--slate-${step}: (#[0-9a-f]{6});`))?.[1];
  const light = palette.slice(0, darkStart);
  const dark = palette.slice(darkStart);

  assert.deepEqual(titleBarOverlayForTheme({ shouldUseDarkColors: false }), {
    color: slate(light, 1),
    symbolColor: slate(light, 12),
    height: 40,
  });
  assert.deepEqual(titleBarOverlayForTheme({ shouldUseDarkColors: true }), {
    color: slate(dark, 1),
    symbolColor: slate(dark, 12),
    height: 40,
  });
});

test("matches the renderer's native title bar height", () => {
  const tokens = readFileSync(new URL("../../app/src/app/index.css", import.meta.url), "utf8");
  assert.match(tokens, /:root \{\s*--window-titlebar-height: 40px;/);
});
