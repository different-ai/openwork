import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("UI control commands never activate the desktop window implicitly", async () => {
  const source = await readFile(new URL("./ui-control-server.mjs", import.meta.url), "utf8");

  assert.match(source, /webContents\.executeJavaScript/);
  assert.doesNotMatch(source, /\bwin\.(?:show|restore|focus)\(/);
});
