// Against a disposable headed Chromium with CDP on loopback. Never attach to a person's real profile.
// node packages/computer-use/scripts/prove-browser-recovery.mjs http://127.0.0.1:9222 /path/to/evidence [--recovery]
// Linux desktop images provide ImageMagick (`convert`) for the existing screenshot adapter.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudBrowser } from "../chromium.mjs";

const [endpoint, output] = process.argv.slice(2);
if (!endpoint || !output) throw new Error("Provide a disposable Chromium's loopback endpoint and evidence directory.");
const address = new URL(endpoint);
if (!['127.0.0.1', 'localhost'].includes(address.hostname)) throw new Error("Use a loopback endpoint only.");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "browser-proof-"));
const browser = createCloudBrowser({ statePath: join(directory, "tabs.json"), endpoint,
  // The local proof may run outside a desktop image, without its kernel UID policy. This is never a production option.
  verifyEgress: async () => {}, assertActive() {}, enabled: () => true, beforeInput: async () => {} });
const recovery = process.argv.includes("--recovery");
const receipts = [];
const request = async (operation, args) => {
  const at = Date.now();
  const result = await browser.request({ sessionId: "browser-proof", operation, args }, { recovery });
  receipts.push({ operation, ms: Date.now() - at, ok: result.ok, code: result.code, page: result.page,
    tabId: result.tabId, pageChars: result.pageChars, next: result.next, completed: result.completed, failed: result.failed });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};
try {
  const opened = await request("open", { url: "https://www.youtube.com/" });
  const tabId = opened.tabId;
  const home = await request("extract", { tabId, question: "videos" });
  assert.ok(home.pageChars > 0, "the home page has readable text");
  const before = await request("observe", { tabId, mode: "interactive", includeImage: true });
  await writeFile(join(output, "youtube-home.png"), Buffer.from(before.image.data, "base64"));
  const search = before.elements.find(e => ["textbox", "searchbox", "combobox"].includes(e.role) && /search/i.test(e.name));
  assert.ok(search, "the page exposes its Search control");
  const acted = await request("act", { tabId, observationId: before.observationId, request_id: "search-once",
    actions: [{ type: "fill", ref: search.ref, text: "relaxing music" }, { type: "key", ref: search.ref, key: "Enter" }] });
  assert.equal(acted.completed, 2);
  // The action receipt is bounded to three seconds; a slow real website can still be loading.
  const results = await request("extract", { tabId, question: "music videos" });
  assert.ok(results.pageChars > 100, "search results have readable text");
  const after = await request("observe", { tabId, mode: "full", includeImage: true });
  await writeFile(join(output, "youtube-results.png"), Buffer.from(after.image.data, "base64"));
  await request("navigate", { tabId, url: "https://en.wikipedia.org/wiki/YouTube" });
  const article = await request("extract", { tabId, question: "When was YouTube founded?" });
  assert.ok(article.pageChars > 1000);
  const tabs = await request("tabs", {});
  assert.equal(tabs.tabs[0].status, "idle");
} finally {
  browser.close();
  const report = { recovery, endpoint, receipts };
  await writeFile(join(output, "receipts.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
