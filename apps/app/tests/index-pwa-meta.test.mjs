import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("PWA declares the standard mobile web app capability", () => {
  assert.match(html, /<meta name="mobile-web-app-capable" content="yes"\s*\/>/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes"\s*\/>/);
});
