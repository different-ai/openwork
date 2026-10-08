import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBrowserSessionAllows } from "./browser-session-allows.mjs";

function profile() {
  const dir = mkdtempSync(path.join(tmpdir(), "browser-session-allows-"));
  return { filePath: path.join(dir, "browser-session-allows.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("an allowed session is remembered after a restart and forgotten when the session is deleted", (t) => {
  const { filePath, cleanup } = profile();
  t.after(cleanup);
  const first = createBrowserSessionAllows({ filePath });
  assert.equal(first.has("ses_a"), false);
  first.add("ses_a");
  first.add("ses_b");
  const restarted = createBrowserSessionAllows({ filePath });
  assert.equal(restarted.has("ses_a"), true);
  assert.equal(restarted.has("ses_b"), true);
  assert.equal(restarted.has("ses_c"), false);
  restarted.remove("ses_a");
  const again = createBrowserSessionAllows({ filePath });
  assert.equal(again.has("ses_a"), false);
  assert.equal(again.has("ses_b"), true);
});

test("a missing or corrupt file starts with no allowed sessions", (t) => {
  const { filePath, cleanup } = profile();
  t.after(cleanup);
  assert.equal(createBrowserSessionAllows({ filePath }).has("ses_a"), false);
  writeFileSync(filePath, "{not json", "utf8");
  const store = createBrowserSessionAllows({ filePath });
  assert.equal(store.has("ses_a"), false);
  store.add("ses_a");
  assert.equal(createBrowserSessionAllows({ filePath }).has("ses_a"), true);
});
