import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

const SCRIPT = fileURLToPath(new URL("./demo-microsoft365.mjs", import.meta.url));
const TOKEN = "demo-microsoft365-token";
let child: ChildProcess;
let base = "";
let rpcId = 0;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string { if (typeof value !== "string") throw new Error("Expected string"); return value; }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error("Expected array"); return value; }
async function json(response: Response): Promise<Record<string, unknown>> { return record(await response.json()); }
async function rest(path: string, init: RequestInit = {}) {
  return fetch(`${base}/v1.0${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...init.headers } });
}
async function rpc(method: string, params: Record<string, unknown> = {}) {
  return json(await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) }));
}
async function tool(name: string, args: Record<string, unknown>) {
  const envelope = await rpc("tools/call", { name, arguments: args }); const result = record(envelope.result);
  const content = record(array(result.content)[0]);
  return { isError: result.isError, text: string(content.text) };
}
async function toolValue(name: string, args: Record<string, unknown>) {
  const result = await tool(name, args); expect(result.isError, result.text).toBe(false); return record(JSON.parse(result.text));
}
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; server.close(() => resolve(port)); });
  });
}
beforeAll(async () => {
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port), DEMO_NOW: "2026-10-16T15:55:00Z" }, stdio: "ignore" });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error("Demo Microsoft 365 did not start");
});
afterAll(() => { child?.kill(); });
beforeEach(async () => { expect((await fetch(`${base}/reset`, { method: "POST" })).status).toBe(200); });

// Inspect ZIP local records: seed files use stored entries and a real central directory.
function officeParts(bytes: Buffer): Record<string, string> {
  const entries: Record<string, string> = {}; let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    expect(bytes.readUInt16LE(offset + 8)).toBe(0);
    const length = bytes.readUInt32LE(offset + 18); const nameLength = bytes.readUInt16LE(offset + 26); const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString(); const start = offset + 30 + nameLength + extraLength;
    entries[name] = bytes.subarray(start, start + length).toString(); offset = start + length;
  }
  expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
  expect(bytes.readUInt32LE(bytes.length - 22)).toBe(0x06054b50);
  expect(bytes.readUInt16LE(bytes.length - 12)).toBe(Object.keys(entries).length);
  expect(entries["[Content_Types].xml"]).toContain("<Types"); expect(entries["_rels/.rels"]).toContain("officeDocument"); return entries;
}

describe("fictional Microsoft 365 demo", () => {
  test("has health, synthetic-only Graph auth and both Graph base URL forms", async () => {
    expect(await json(await fetch(`${base}/health`))).toMatchObject({ fictional: true, externalDelivery: false });
    expect((await fetch(`${base}/v1.0/me`)).status).toBe(401);
    expect((await fetch(`${base}/v1.0/me`, { headers: { authorization: "Bearer real-looking-token" } })).status).toBe(401);
    expect(await json(await rest("/me"))).toMatchObject({ displayName: "Alex Chen", mail: "alex@acme.test" });
    expect((await fetch(`${base}/graph/v1.0/me`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });

  test("searches real seeded threads, folders and paginated results", async () => {
    const result = await json(await rest('/me/messages?$search="Northwind"&$top=1'));
    expect(array(result.value)).toHaveLength(1); expect(string(record(array(result.value)[0]).bodyPreview)).toMatch(/Northwind|Firmware/);
    const next = string(result["@odata.nextLink"]); expect(next).toContain("%24skip=1");
    expect(array((await json(await fetch(base + next, { headers: { authorization: `Bearer ${TOKEN}` } }))).value)).toHaveLength(1);
    const thread = await json(await rest("/me/messages?$filter=" + encodeURIComponent("conversationId eq 'thread-blueharbor'")));
    expect(array(thread.value)).toHaveLength(2);
    const folderList = await json(await rest("/me/mailFolders")); expect(array(folderList.value)).toHaveLength(5);
    expect((await rest("/me/messages?$top=-1")).status).toBe(400);
    expect((await rest("/me/messages?$filter=unknown")).status).toBe(400);
  });

  test("MCP creates a real reply draft in the source conversation without sending", async () => {
    const inbox = await json(await rest("/me/mailFolders/inbox/messages"));
    const source = record(array(inbox.value)[0]);
    const draft = await toolValue("mail_create_reply_draft", { message_id: string(source.id), body: "Product comparison: http://127.0.0.1/document" });
    expect(draft).toMatchObject({ isDraft: true, parentFolderId: "drafts", conversationId: source.conversationId });
    expect(array(draft.toRecipients)).toEqual([source.from]);
    expect(await json(await rest(`/me/messages/${string(draft.id)}`))).toMatchObject({ conversationId: source.conversationId, isDraft: true });
    expect(array((await json(await rest("/me/mailFolders/sentitems/messages"))).value)).toHaveLength(0);
  });

  test("draft, patch and send share one state with MCP; sends never deliver externally", async () => {
    const draft = await toolValue("mail_create_draft", { subject: "Northwind decision notes", body: "Please verify the aisle C test.", to: ["priya@acme.test"] }); const id = string(draft.id);
    expect(draft.isDraft).toBe(true);
    expect((await rest(`/me/messages/${id}`, { method: "PATCH", body: JSON.stringify({ body: { contentType: "Text", content: "Updated notes: 12 committed units." } }) })).status).toBe(200);
    expect((await toolValue("mail_read", { message_id: id })).bodyPreview).toContain("12 committed");
    const sent = await toolValue("mail_send", { message_id: id }); expect(sent).toMatchObject({ deliveredExternally: false, status: "sent_in_demo_only" });
    expect(await json(await rest(`/me/messages/${id}`))).toMatchObject({ isDraft: false, parentFolderId: "sentitems" });
    expect((await rest(`/me/messages/${id}/send`, { method: "POST" })).status).toBe(400);
    expect((await rest(`/me/messages/${id}`, { method: "PATCH", body: JSON.stringify({ subject: "Cannot rewrite sent mail" }) })).status).toBe(400);
    const sentFolder = await json(await rest("/me/mailFolders/sentitems/messages")); expect(array(sentFolder.value)).toHaveLength(1);
  });

  test("reply drafts retain thread; invalid mutation is atomic; empty recipients cannot send", async () => {
    const reply = await json(await rest("/me/messages/mail-northwind-2/createReply", { method: "POST", body: JSON.stringify({ comment: "Can you confirm field validation?" }) }));
    expect(reply).toMatchObject({ conversationId: "thread-northwind", isDraft: true });
    const recipients = array(reply.toRecipients); expect(record(record(recipients[0]).emailAddress).address).toBe("priya@acme.test");
    const id = string(reply.id);
    expect((await rest(`/me/messages/${id}`, { method: "PATCH", body: JSON.stringify({ subject: "Should not persist", toRecipients: [{ emailAddress: { address: "invalid" } }] }) })).status).toBe(400);
    expect((await json(await rest(`/me/messages/${id}`))).subject).toBe(reply.subject);
    const blank = await json(await rest("/me/messages", { method: "POST", body: "{}" }));
    expect((await rest(`/me/messages/${string(blank.id)}/send`, { method: "POST" })).status).toBe(400);
    expect((await rest("/me/messages/missing")).status).toBe(404);
  });

  test("mail command-bar mutations update shared folders and unread counts without delivery", async () => {
    const id = "mail-blueharbor-2";
    expect((await rest(`/me/messages/${id}`, { method: "PATCH", body: JSON.stringify({ isRead: true }) })).status).toBe(200);
    expect((await toolValue("mail_read", { message_id: id })).isRead).toBe(true);
    const moved = await json(await rest(`/me/messages/${id}/move`, { method: "POST", body: JSON.stringify({ destinationId: "archive" }) }));
    expect(moved).toMatchObject({ id, parentFolderId: "archive", isDraft: false });
    expect(await json(await rest("/me/mailFolders/archive"))).toMatchObject({ totalItemCount: 1, unreadItemCount: 0 });
    expect((await rest(`/me/messages/${id}`, { method: "PATCH", body: JSON.stringify({ isRead: false }) })).status).toBe(200);
    expect(await json(await rest("/me/mailFolders/archive"))).toMatchObject({ totalItemCount: 1, unreadItemCount: 1 });
    expect((await rest(`/me/messages/${id}/move`, { method: "POST", body: JSON.stringify({ destinationId: "missing" }) })).status).toBe(400);
    expect((await toolValue("mail_read", { message_id: id })).parentFolderId).toBe("archive");
    await rest(`/me/messages/${id}/move`, { method: "POST", body: JSON.stringify({ destinationId: "deleteditems" }) });
    expect(await json(await rest("/me/mailFolders/deleteditems"))).toMatchObject({ totalItemCount: 1, unreadItemCount: 1 });
    await rest(`/me/messages/${id}/move`, { method: "POST", body: JSON.stringify({ destinationId: "inbox" }) });
    expect((await toolValue("mail_read", { message_id: id })).parentFolderId).toBe("inbox");
    expect(array((await json(await rest("/me/mailFolders/sentitems/messages"))).value)).toHaveLength(0);
  });

  test("seeds useful real Office ZIP bytes with document, workbook and presentation parts", async () => {
    const files = array((await json(await rest("/me/drive/root/children"))).value).map(record);
    expect(files).toHaveLength(4);
    for (const file of files.filter((entry) => /\.(docx|xlsx|pptx)$/.test(string(entry.name)))) {
      const response = await rest(`/me/drive/items/${string(file.id)}/content`); const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.length).toBe(file.size); const entries = officeParts(bytes);
      const content = Object.values(entries).join(" "); expect(content).toMatch(/Northwind|AtlasLift/);
      expect(response.headers.get("etag")).toBe(file.eTag);
      if (string(file.name).endsWith(".docx")) expect(entries["word/document.xml"]).toContain("497/500");
      if (string(file.name).endsWith(".xlsx")) expect(entries["xl/worksheets/sheet1.xml"]).toContain("768000");
      if (string(file.name).endsWith(".pptx")) { expect(entries["ppt/slides/slide3.xml"]).toContain("1,200 kg"); expect(entries["ppt/presentation.xml"]).toContain('id="258"'); }
      const extracted = await json(await fetch(`${base}/preview/${string(file.id)}`)); expect(extracted.kind).toBe("Extracted Office text (not an Office editor)"); expect(string(extracted.text)).toContain("Northwind");
      expect(Buffer.from(await (await fetch(`${base}/download/${string(file.id)}`)).arrayBuffer())).toEqual(bytes);
    }
  });

  test("uploads exact binary bytes, reads after writes, increments revisions and guards stale eTags", async () => {
    const original = Buffer.from([0, 255, 80, 75, 10, 0, 17, 128]);
    const uploadedResponse = await rest("/me/drive/root:/evidence.bin:/content", { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: original }); expect(uploadedResponse.status).toBe(201);
    const uploaded = await json(uploadedResponse); const id = string(uploaded.id);
    expect(Buffer.from(await (await rest(`/me/drive/items/${id}/content`)).arrayBuffer())).toEqual(original);
    const updated = await json(await rest(`/me/drive/items/${id}/content`, { method: "PUT", headers: { "content-type": "application/octet-stream", "if-match": string(uploaded.eTag) }, body: Buffer.from([1, 2, 3]) }));
    expect(updated.revision).toBe(2); expect(updated.eTag).not.toBe(uploaded.eTag); expect(updated.id).toBe(id);
    expect((await rest(`/me/drive/items/${id}/content`, { method: "PUT", headers: { "if-match": string(uploaded.eTag) }, body: "stale" })).status).toBe(412);
    expect(Buffer.from(await (await rest(`/me/drive/items/${id}/content`)).arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
    const found = await json(await rest("/me/drive/root/search(q='evidence')")); expect(array(found.value)).toHaveLength(1);
  });

  test("MCP text and binary writes are visible in REST and safe previews", async () => {
    const file = await toolValue("file_write", { path: "Meeting notes.txt", content: "AtlasLift action items\n<script>alert('fictional')</script>" }); const id = string(file.id);
    const read = await toolValue("file_read", { item_id: id }); expect(read.text).toContain("AtlasLift action items");
    expect(Buffer.from(string(read.content_base64), "base64").toString()).toBe(read.text);
    const edited = await toolValue("file_write", { path: "Meeting notes.txt", content: "Updated from agent", if_match: string(file.eTag) }); expect(edited.id).toBe(id); expect(edited.revision).toBe(2);
    expect((await rest(`/me/drive/items/${id}/content`)).headers.get("content-type")).toBe("text/plain");
    expect((await (await rest(`/me/drive/items/${id}/content`)).text())).toBe("Updated from agent");
    const binary = await toolValue("file_write", { path: "payload.bin", content_base64: "AP8BAg==" });
    expect(Buffer.from(await (await rest(`/me/drive/items/${string(binary.id)}/content`)).arrayBuffer())).toEqual(Buffer.from([0, 255, 1, 2]));
    expect((await tool("file_write", { path: "bad.txt", content: "x", content_base64: "eA==" })).isError).toBe(true);
    expect((await tool("file_write", { path: "bad.txt", content_base64: "not base64" })).isError).toBe(true);
  });

  test("folders require real parents and prevent unsafe paths or collisions", async () => {
    expect((await rest("/me/drive/root:/Missing/file.txt:/content", { method: "PUT", body: "x" })).status).toBe(404);
    const folder = await toolValue("file_create_folder", { name: "Customer reviews" });
    expect((await rest("/me/drive/root/children", { method: "POST", body: JSON.stringify({ name: "Customer reviews", folder: {} }) })).status).toBe(409);
    expect((await tool("file_write", { path: "../unsafe.txt", content: "no" })).isError).toBe(true);
    const created = await toolValue("file_write", { path: "Customer reviews/next-actions.txt", content: "Priya owns the field validation." });
    expect(record(created.parentReference).id).toBe(folder.id);
    expect(array((await json(await rest(`/me/drive/items/${string(folder.id)}/children`))).value)).toHaveLength(1);
    expect((await rest(`/me/drive/items/${string(folder.id)}/content`)).status).toBe(400);
  });

  test("calendar create/list/get/update/delete are shared and range-aware", async () => {
    const created = await toolValue("calendar_create", { subject: "AtlasLift charging layout review", start: "2026-11-20T09:00:00Z", end: "2026-11-20T09:30:00Z", location: "Lab B", attendees: ["kenji@acme.test"] }); const id = string(created.id);
    expect(record(created.location).displayName).toBe("Lab B");
    const listed = await toolValue("calendar_list", { start: "2026-11-20T00:00:00Z", end: "2026-11-21T00:00:00Z" }); expect(array(listed.value).map(record).some((entry) => entry.id === id)).toBe(true);
    expect(await json(await rest(`/me/events/${id}`))).toMatchObject({ subject: "AtlasLift charging layout review" });
    expect((await rest(`/me/events/${id}`, { method: "PATCH", body: JSON.stringify({ subject: "Updated review" }) })).status).toBe(200);
    expect((await rest("/me/events", { method: "POST", body: JSON.stringify({ subject: "Invalid dates", start: { dateTime: "2026-11-20T10:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-11-20T09:00:00Z", timeZone: "UTC" } }) })).status).toBe(400);
    expect((await rest(`/me/events/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await rest(`/me/events/${id}`)).status).toBe(404);
  });

  test("MCP reschedules Graph-shaped events atomically while preserving agenda, attendees and identity", async () => {
    const created = await toolValue("calendar_create", {
      subject: "Acceptance review", body: { contentType: "HTML", content: "<p>Review field logs, then assign owners.</p>" },
      start: { dateTime: "2026-11-20T09:00:00", timeZone: "Pacific Standard Time" },
      end: { dateTime: "2026-11-20T10:00:00", timeZone: "Pacific Standard Time" },
      attendees: [{ emailAddress: { address: "priya@acme.test", name: "Priya Shah" }, type: "optional" }], location: "Lab B",
    });
    const id = string(created.id);
    const updated = await toolValue("calendar_update", { event_id: id, start: "2026-11-23T11:00:00", end: "2026-11-23T12:00:00", time_zone: "Europe/Paris" });
    expect(updated).toMatchObject({ id, subject: created.subject, body: created.body, attendees: created.attendees, organizer: created.organizer, location: created.location, createdDateTime: created.createdDateTime, webLink: created.webLink });
    expect(updated.start).toEqual({ dateTime: "2026-11-23T11:00:00", timeZone: "Europe/Paris" });
    expect(await toolValue("calendar_read", { event_id: id })).toEqual(updated);
    expect(array((await toolValue("calendar_list", { start: "2026-11-23T10:30:00Z", end: "2026-11-23T10:45:00Z" })).value)).toHaveLength(1);
    expect(array((await toolValue("calendar_list", { start: "2026-11-23T11:00:00Z", end: "2026-11-23T12:00:00Z" })).value)).toHaveLength(0);
    expect((await tool("calendar_update", { event_id: id, subject: "Must not persist", end: "2026-11-23T08:00:00Z" })).isError).toBe(true);
    expect(await toolValue("calendar_read", { event_id: id })).toEqual(updated);
    expect((await rest(`/me/events/${id}`, { method: "PATCH", body: JSON.stringify({ subject: "Must not persist", unsupported: true }) })).status).toBe(400);
    expect(await toolValue("calendar_read", { event_id: id })).toEqual(updated);
    const pacific = await toolValue("calendar_create", { subject: "Pacific range", start: "2026-11-20T09:00:00", end: "2026-11-20T10:00:00", time_zone: "Pacific Standard Time" });
    expect(array((await toolValue("calendar_list", { start: "2026-11-20T17:30:00Z", end: "2026-11-20T17:45:00Z" })).value).map(record).map((item) => item.id)).toEqual([pacific.id]);
  });

  test("audits only actual MCP calls with wall-clock correlation, immutable provider outputs, bounded retention and reset", async () => {
    const started = Date.now();
    const created = await toolValue("calendar_create", { subject: "Audit original", start: "2026-11-20T09:00:00Z", end: "2026-11-20T10:00:00Z" });
    const failed = await tool("calendar_read", { event_id: "missing" });
    const ended = Date.now();
    await rest(`/me/events/${string(created.id)}`, { method: "PATCH", body: JSON.stringify({ subject: "REST change is not an MCP call" }) });
    await rpc("tools/list"); await rpc("ping");
    const audit = array((await json(await fetch(`${base}/state`))).audit).map(record);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ sequence: 1, name: "calendar_create", status: "completed", output: created });
    expect(record(audit[0]?.output).subject).toBe("Audit original");
    expect(audit[1]).toMatchObject({ sequence: 2, name: "calendar_read", input: { event_id: "missing" }, output: failed.text, status: "error" });
    for (const entry of audit) { expect(entry.at).toBeGreaterThanOrEqual(started); expect(entry.at).toBeLessThanOrEqual(ended); expect(entry).not.toHaveProperty("callId"); }
    for (let i = 0; i < 1001; i++) await toolValue("calendar_read", { event_id: string(created.id) });
    const retained = array((await json(await fetch(`${base}/state`))).audit).map(record);
    expect(retained).toHaveLength(1000); expect(retained[0]?.sequence).toBe(4); expect(retained.at(-1)?.sequence).toBe(1003);
    await fetch(`${base}/reset`, { method: "POST" });
    expect((await json(await fetch(`${base}/state`))).audit).toEqual([]);
    await toolValue("calendar_list", {});
    expect(record(array((await json(await fetch(`${base}/state`))).audit)[0]).sequence).toBe(1);
  });

  test("MCP handshake, schemas, notifications and errors are sensible demo-only surfaces", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18" }); expect(record(init.result).protocolVersion).toBe("2025-06-18"); expect(record(record(init.result).serverInfo).name).toContain("DEMO");
    const tools = array(record((await rpc("tools/list")).result).tools).map(record); expect(tools).toHaveLength(13);
    for (const entry of tools) {
      expect(string(entry.description)).toContain("DEMO ONLY");
      expect(string(entry.description)).toContain(string(entry.name).startsWith("file_") ? "OneDrive" : "Outlook");
      expect(record(entry.annotations).openWorldHint).toBe(false);
    }
    expect(record(tools.find((entry) => entry.name === "mail_send")?.annotations).destructiveHint).toBe(true);
    expect((await tool("mail_read", {})).isError).toBe(true); expect((await tool("missing_tool", {})).isError).toBe(true);
    expect((await fetch(`${base}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).status).toBe(202);
    expect(record((await rpc("missing_method")).error).code).toBe(-32601);
    expect(record((await json(await fetch(`${base}/mcp`, { method: "POST", body: "{" }))).error).code).toBe(-32700);
  });

  test("local browser surfaces offer real controls and safe text-only previews", async () => {
    const home = await (await fetch(base)).text(); expect(home).toContain('href="/outlook"'); expect(home).toContain('href="/onedrive"');
    for (const path of ["/outlook", "/onedrive"]) {
      const response = await fetch(base + path); const html = await response.text(); expect(html).toContain("Fictional demo"); expect(html).toContain("setInterval(refresh,1800)"); expect(html).toContain("textContent=p.text"); expect(response.headers.get("content-security-policy")).toContain("object-src 'none'"); expect(html).not.toContain("innerHTML=p.text"); const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]; expect(script).toBeTruthy(); expect(() => new Script(script || "")).not.toThrow();
    }
    const file = await toolValue("file_write", { path: "broken.docx", content: "not a real zip" }); const p = await json(await fetch(`${base}/preview/${string(file.id)}`)); expect(p.kind).toBe("Download only");
    expect((await fetch(`${base}/reset`, { method: "POST", headers: { origin: "https://hostile.invalid" } })).status).toBe(403);
  });

  test("rejects oversized uploads, malformed input and unsafe cross-origin requests without mutation", async () => {
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
    expect((await rest("/me/drive/root:/too-big.bin:/content", { method: "PUT", body: oversized })).status).toBe(413);
    expect(array((await json(await rest("/me/drive/root/children"))).value)).toHaveLength(4);
    expect((await rest("/me/messages", { method: "POST", body: "{" })).status).toBe(400);
    expect((await rest("/me/messages/%FF")).status).toBe(400);
    expect((await rest("/me/events", { method: "POST", body: JSON.stringify({ subject: "Bad attendee list", start: { dateTime: "2026-11-20T09:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-11-20T10:00:00Z", timeZone: "UTC" }, attendees: "not an array" }) })).status).toBe(400);
  });

  test("reset restores seed mail, calendar and original Office bytes", async () => {
    const original = await json(await fetch(`${base}/state`));
    await toolValue("file_write", { path: "temporary.txt", content: "ephemeral" });
    await toolValue("mail_create_draft", { subject: "temporary", body: "ephemeral", to: [] });
    await fetch(`${base}/reset`, { method: "POST" }); const restored = await json(await fetch(`${base}/state`));
    expect(array(restored.files)).toHaveLength(array(original.files).length); expect(array(restored.messages)).toHaveLength(array(original.messages).length); expect(array(restored.events)).toHaveLength(1);
    expect(restored).toEqual(original); // DEMO_NOW also resets generated IDs and seed timestamps.
    expect(array(restored.files).map(record).map((entry) => entry.name)).not.toContain("temporary.txt");
    expect(array(restored.files).map(record).map((entry) => record(record(entry.file).hashes).sha256Hash)).toEqual(array(original.files).map(record).map((entry) => record(record(entry.file).hashes).sha256Hash));
  });
});
