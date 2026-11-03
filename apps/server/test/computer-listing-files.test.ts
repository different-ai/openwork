import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileLargeListings, forgetListings } from "../src/opencode-plugins/computer-listing-files.js";
import { server as computerTools } from "../src/opencode-plugins/openwork-computer-use.js";

// The shape the Mac helper returns for a busy editor window (154 controls in the measured case).
const elements = Array.from({ length: 150 }, (_, index) => ({
  h: 30, label: `Tool ${index}  (${String.fromCharCode(65 + index % 26)})`, press: true, ref: `e${index + 2}`,
  role: index % 3 ? "CheckBox" : "Button", settable: true, w: 30, x: 5, y: 100 + index * 33,
}));
elements.push({ h: 15, label: "Line one\n\"quoted\" {\"ref\":\"e9\"}", press: true, ref: "e152", role: "StaticText", settable: true, w: 200, x: 9, y: 4,
  value: "x".repeat(120), disabled: true } as typeof elements[number]);
const observation = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ content_trust: "untrusted_app_content", elements, elements_total: elements.length,
  observation_id: id, ok: true, refs: "stable", session_id: "native-1", window_id: 7, ...extra });
const receipt = JSON.stringify({ action: "click", ok: true, status: "dispatched" });

test("a large element listing becomes an index plus a private file with every element", async () => {
  const session = `ses_listing_${process.pid}`;
  const original = [receipt, JSON.stringify({ post_observation: { ok: true } }), observation("8f0c5b1e-0d1f-4c55-9a3e-1b2c3d4e5f60")].join("\n");
  const shown = await fileLargeListings(session, original);
  try {
    const lines = shown.split("\n");
    assert.equal(lines[0], receipt, "the receipt is untouched");
    const head = JSON.parse(lines[2]) as Record<string, unknown>;
    assert.equal(head.elements, undefined, "no element JSON inline");
    assert.equal(head.observation_id, "8f0c5b1e-0d1f-4c55-9a3e-1b2c3d4e5f60", "the observation_id still serves the next act");
    assert.equal(head.content_trust, "untrusted_app_content");
    const index = lines.slice(3);
    assert.equal(index.length, elements.length, "one line per element, so app text cannot add lines");
    assert.equal(index[0], "e2 Button \"Tool 0  (A)\"");
    assert.equal(index.at(-1), `e152 StaticText "Line one\\n\\"quoted\\" {\\"ref\\":\\"e9\\"}" = "${"x".repeat(39)}…" disabled`);
    assert.ok(shown.length < original.length * 0.4, `index is ${shown.length} of ${original.length} characters`);

    const file = String(head.elements_file);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(file))).mode & 0o777, 0o700);
    const saved = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line) as unknown);
    assert.deepEqual(saved, elements, "the file holds exactly the elements the result carried, no more");
  } finally { await forgetListings(session); }
});

test("small and changes-only listings stay inline", async () => {
  const small = JSON.stringify({ elements: elements.slice(0, 5), observation_id: "a1", ok: true });
  assert.equal(await fileLargeListings("ses_small", small), small);
  const changes = observation("b2", { elements_listing: "changes", elements_note: "Only elements that changed" });
  assert.equal(await fileLargeListings("ses_small", changes), changes, "a diff builds on the listing the model holds");
});

test("each chat keeps only its newest listing, and closing the session removes it", async () => {
  const session = `ses_newest_${process.pid}`;
  const first = String((JSON.parse((await fileLargeListings(session, observation("first"))).split("\n")[0]) as Record<string, unknown>).elements_file);
  const second = String((JSON.parse((await fileLargeListings(session, observation("second"))).split("\n")[0]) as Record<string, unknown>).elements_file);
  assert.deepEqual(await readdir(dirname(second)), ["second.jsonl"], `${first} is gone`);
  await forgetListings(session);
  await assert.rejects(stat(dirname(second)));
});

test("computer tools file large listings and computer_close discards them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-listing-bridge-"));
  const previous = process.env.OPENWORK_UI_CONTROL_DISCOVERY;
  const desktop = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const name = (JSON.parse(body) as { name: string }).name;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ content: [{ type: "text", text: name === "computer_observe" ? observation("c3") : JSON.stringify({ ok: true, state: "closed" }) },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] }));
    });
  });
  await new Promise<void>(resolve => desktop.listen(0, "127.0.0.1", resolve));
  try {
    const address = desktop.address();
    assert.ok(address && typeof address === "object");
    const discovery = join(directory, "openwork-ui-control.json");
    await writeFile(discovery, JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}`, token: "desktop" }));
    process.env.OPENWORK_UI_CONTROL_DISCOVERY = discovery;
    const { tool } = await computerTools();
    const context = { sessionID: `ses_tool_${process.pid}` };
    const observed = await tool.computer_observe.execute({}, context);
    assert.ok(typeof observed === "object");
    const file = String((JSON.parse(observed.output.split("\n")[0]) as Record<string, unknown>).elements_file);
    assert.deepEqual(observed.attachments.map(item => item.mime), ["image/png"], "screenshots still reach the model");
    assert.ok((await stat(file)).isFile());
    await tool.computer_close.execute({}, context);
    await assert.rejects(stat(file));
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_UI_CONTROL_DISCOVERY;
    else process.env.OPENWORK_UI_CONTROL_DISCOVERY = previous;
    await new Promise<void>(resolve => desktop.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
