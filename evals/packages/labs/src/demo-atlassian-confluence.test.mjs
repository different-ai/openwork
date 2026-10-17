// Focused, model-free regression checks against the real fixture HTTP/MCP surfaces.
// node --test evals/packages/labs/src/demo-atlassian-confluence.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

async function fixture(t) {
  const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, [new URL("./demo-atlassian.mjs", import.meta.url).pathname], { env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DEMO_NOW: "2026-10-16T16:00:00Z" }, stdio: "ignore" });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; } });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    if (await fetch(base + "/health").then((r) => r.ok).catch(() => false)) break;
    if (attempt > 100) throw new Error("Fixture failed to start"); await delay(30);
  }
  let sequence = 0;
  const tool = async (name, args) => {
    const response = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name, arguments: args } }) });
    const rpc = await response.json(); assert.equal(rpc.result.isError, false, rpc.result.content[0].text);
    return JSON.parse(rpc.result.content[0].text);
  };
  const rest = async (path, method = "GET", body) => {
    const response = await fetch(base + "/confluence/rest/api" + path, { method, headers: { authorization: "Bearer fictional-fixture-pat", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, value: await response.json() };
  };
  return { tool, rest, state: async () => (await fetch(base + "/state")).json() };
}

const addition = "Workshop review: office guidance checked on 2026-10-16; dog-policy confirmation remains with People Ops.";
const review = "Workshop review complete; please confirm the dog-policy gap with People Ops.";

test("MCP metadata wrapper and Markdown comment payload survive actual state and API readbacks", async (t) => {
  const { tool, rest, state } = await fixture(t);
  const result = await tool("confluence_get_page", { title: "Working at the office", space_key: "HB" });
  assert.deepEqual(Object.keys(result), ["metadata"]);
  const { metadata: page } = result;
  assert.equal(typeof page.version, "number");
  const added = await tool("confluence_add_comment", { page_id: page.id, body: review });
  assert.equal(added.success, true);
  assert.equal(added.comment.body, review);
  const stored = (await state()).confluence.pages.find((entry) => entry.id === page.id);
  assert.deepEqual(stored.comments.map((comment) => ({ id: comment.id, body: comment.body })), [{ id: added.comment.id, body: `<p>${review}</p>` }]);
  const readback = await tool("confluence_get_comments", { page_id: page.id });
  assert.equal(readback[0].id, added.comment.id);
  assert.equal(readback[0].body, review);
  const raw = (await rest(`/content/${page.id}/child/comment?expand=body.storage`)).value.results;
  assert.equal(raw[0].body.storage.value, `<p>${review}</p>`);
});

test("MCP Markdownify page can be appended and saved without destroying existing storage structure", async (t) => {
  const { tool, rest } = await fixture(t);
  const { metadata: original } = await tool("confluence_get_page", { title: "Working at the office", space_key: "HB" });
  assert.equal(original.content.format, "markdown");
  assert.match(original.content.value, /^Working at the office\n=+/);
  const before = (await rest(`/content/${original.id}?expand=body.storage,version`)).value;
  await tool("confluence_update_page", { page_id: original.id, title: original.title, content: original.content.value + "\n\n" + addition, version_comment: "Office review", include_content: true });
  const after = (await rest(`/content/${original.id}?expand=body.storage,version`)).value;
  assert.equal(after.version.number, before.version.number + 1);
  // Preserve all original headings, paragraphs, lists and factual text, not just a few sentinel words.
  assert.equal(after.body.storage.value, before.body.storage.value + `<p>${addition}</p>`);
  const { metadata: readback } = await tool("confluence_get_page", { page_id: original.id });
  assert.equal(readback.version, after.version.number);
  assert.equal(readback.content.value, original.content.value + "\n\n" + addition);
  const added = await tool("confluence_add_comment", { page_id: original.id, body: review });
  assert.equal(added.comment.body, review);
  const comments = await tool("confluence_get_comments", { page_id: original.id });
  assert.deepEqual(comments.map((comment) => ({ id: comment.id, body: comment.body })), [{ id: added.comment.id, body: review }]);
});

test("Confluence retains exact version messages, minor edit and body history through multiple legitimate updates", async (t) => {
  const { tool, rest, state } = await fixture(t);
  const { metadata: page } = await tool("confluence_get_page", { title: "Working at the office", space_key: "HB", convert_to_markdown: false });
  const versions = [page.version, page.version + 1, page.version + 2];
  const bodies = [page.content.value, page.content.value + `<p>${addition}</p>`, page.content.value + `<p>${addition}</p><p>Reviewed by People Ops.</p>`];
  const messages = ["", "Office review", "Review follow-up"];
  for (let step = 1; step <= 2; step++) {
    await tool("confluence_update_page", { page_id: page.id, title: page.title, content: bodies[step], content_format: "storage", is_minor_edit: step === 1, version_comment: messages[step] });
    const current = (await rest(`/content/${page.id}?expand=body.storage,version`)).value;
    assert.equal(current.version.message, messages[step]);
    assert.equal(current.version.minorEdit, step === 1);
    assert.equal(current.version.number, versions[step]);
    assert.equal(current.body.storage.value, bodies[step]);
  }
  const history = (await rest(`/content/${page.id}/version`)).value.results;
  assert.deepEqual(history.map((entry) => ({ number: entry.number, message: entry.message, minorEdit: entry.minorEdit })), [
    { number: versions[2], message: messages[2], minorEdit: false },
    { number: versions[1], message: messages[1], minorEdit: true },
    { number: versions[0], message: messages[0], minorEdit: false },
  ]);
  for (let step = 0; step <= 2; step++) {
    const historical = (await rest(`/content/${page.id}?version=${versions[step]}&expand=body.storage,version`)).value;
    assert.equal(historical.body.storage.value, bodies[step]);
    assert.equal(historical.version.message, messages[step]);
    assert.equal(historical.version.minorEdit, step === 1);
  }
  const stored = (await state()).confluence.pages.find((entry) => entry.id === page.id);
  assert.deepEqual(stored.versions.map((entry) => ({ number: entry.number, body: entry.body })), versions.slice(0, 2).map((number, index) => ({ number, body: bodies[index] })));
});

test("rejected duplicate-title and missing-parent updates cannot create phantom versions or mutate body", async (t) => {
  const { tool, rest, state } = await fixture(t);
  const { metadata: page } = await tool("confluence_get_page", { title: "Working at the office", space_key: "HB", convert_to_markdown: false });
  const before = (await state()).confluence.pages.find((entry) => entry.id === page.id);
  for (const extra of [{ title: "Employee Handbook" }, { ancestors: [{ id: "999" }] }]) {
    const failed = await rest(`/content/${page.id}`, "PUT", { type: "page", title: page.title, body: { storage: { value: "<p>Must not persist</p>" } }, version: { number: page.version + 1 }, ...extra });
    assert.ok(failed.status === 400 || failed.status === 404);
    assert.deepEqual((await state()).confluence.pages.find((entry) => entry.id === page.id), before);
  }
});
