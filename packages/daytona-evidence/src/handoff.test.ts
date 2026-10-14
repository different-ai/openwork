import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { DaytonaApi, type Sandbox, type Snapshot } from "./api.ts";
import { capturePreviewHandoff, finalizePreviewHandoffs, ownPreviewSource } from "./handoff.ts";
import { openDaytonaCheckpoint } from "./checkpoints.ts";
import { EVIDENCE_KIND } from "./kinds.ts";

const owner = { owner: "123-1-core", sourceSha: "a".repeat(40) };
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function labelMap(value: unknown): Record<string, string> {
  assert.ok(object(value));
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
class Provider extends DaytonaApi {
  sandboxes = new Map<string, Sandbox>([["source", { id: "source", name: "source", state: "started", labels: { kind: EVIDENCE_KIND, sourceSha: owner.sourceSha } }]]);
  files = new Map<string, Map<string, string>>([["source", new Map([["/opt/openwork-preview/evidence-ready", "web-v1"], ["chat", "final reply"]])]]);
  snapshots = new Map<string, Snapshot>();
  snapshotFiles = new Map<string, Map<string, string>>();
  deleted: string[] = [];
  requested = 0;
  failSave = false;
  failWait = false;
  failDelete = false;
  ambiguousFork = false;
  constructor() { super({ apiKey: "test", apiUrl: "https://test.invalid", region: "test" }); }
  override async getSandbox(id: string) { return this.sandboxes.get(id) ?? [...this.sandboxes.values()].find(s => s.name === id) ?? null; }
  override async listSandboxes(match: Record<string, string> = {}) { return [...this.sandboxes.values()].filter(s => Object.entries(match).every(([key, value]) => s.labels[key] === value)); }
  override async setLabels(id: string, labels: Record<string, string>) { const s = await this.getSandbox(id); assert.ok(s); s.labels = labels; }
  override async readFile(s: Sandbox, path: string) { return this.files.get(s.id)?.get(path) ?? null; }
  override async writeFile(s: Sandbox, path: string, value: string) { this.files.get(s.id)?.set(path, value); }
  override async forkSandbox(id: string, name: string) {
    const s = await this.getSandbox(id); assert.ok(s);
    const fork = { ...s, id: "fork", name, labels: { ...s.labels } };
    this.sandboxes.set("fork", fork); this.files.set("fork", new Map(this.files.get(id)));
    if (this.ambiguousFork) throw new Error("response lost after provider capture");
    return fork;
  }
  override async waitForSandbox(id: string) { const s = await this.getSandbox(id); assert.ok(s); if (s.state !== "started") throw new Error("fork failed"); return s; }
  override async snapshotSandbox(id: string, name: string) {
    this.requested++; if (this.failSave) throw new Error("provider rejected snapshot");
    this.snapshots.set(name, { id: name, name, state: "creating" });
    this.snapshotFiles.set(name, new Map(this.files.get(id)));
  }
  override async snapshotSandboxOnce(id: string, name: string) { await this.snapshotSandbox(id, name); }
  override async getSnapshot(name: string) { return this.snapshots.get(name) ?? null; }
  override async waitForSnapshot(name: string, timeoutMs?: number) {
    assert.ok(timeoutMs === undefined || timeoutMs <= 600_000);
    if (this.failWait) throw new Error("preview timed out");
    const snapshot = await this.getSnapshot(name); assert.ok(snapshot); snapshot.state = "active"; return snapshot;
  }
  override async deleteSandbox(id: string) {
    if (id === "fork" && this.failDelete) throw new Error("delete rejected");
    if (id === "source") assert.ok(!this.sandboxes.has("fork"), "never release source before fork");
    this.deleted.push(id); this.sandboxes.delete(id);
  }
  override async createSandbox(input: { name: string; snapshot: string; labels: Record<string, string> }) {
    const copy = { id: "copy", name: input.name, state: "started", labels: input.labels };
    this.sandboxes.set("copy", copy); this.files.set("copy", new Map(this.snapshotFiles.get(input.snapshot))); return copy;
  }
  override async signedPreviewUrl() { return "https://private.test"; }
}
async function captured(api: Provider) { await ownPreviewSource("source", owner, api); return capturePreviewHandoff("source", "b".repeat(64), owner, api); }

test("producer starts no background save; fresh finalizer saves and final chat restores after source teardown", async () => {
  const api = new Provider(); const capture = await captured(api);
  assert.equal(capture.deferred, true); assert.equal(api.requested, 0); assert.equal(api.deleted.length, 0);
  // The finalizer has only durable provider state, not a producer promise.
  const result = await finalizePreviewHandoffs(owner, api);
  assert.equal(result[0]?.ready, true); assert.deepEqual(api.deleted, ["fork", "source"]);
  await openDaytonaCheckpoint(capture.checkpoint, "c".repeat(32), "00000000-0000-4000-8000-000000000000", api);
  assert.equal(api.files.get("copy")?.get("chat"), "final reply");
  assert.equal((await finalizePreviewHandoffs(owner, api)).length, 0);
});

const failures: ("failSave" | "failWait")[] = ["failSave", "failWait"];
for (const failure of failures) test(`${failure}: preview error cleans fork then source, never reports readiness`, async () => {
  const api = new Provider(); await captured(api); api[failure] = true;
  await assert.rejects(finalizePreviewHandoffs(owner, api, { timeoutMs: 1 }), /Optional preview/);
  assert.deepEqual(api.deleted, ["fork", "source"]);
});

test("canceled producer with lost fork response is recovered from the pre-request receipt", async () => {
  const api = new Provider(); api.ambiguousFork = true;
  await assert.rejects(captured(api), /response lost/);
  await finalizePreviewHandoffs(owner, api, { cleanupOnly: true });
  assert.equal(api.requested, 0); assert.deepEqual(api.deleted, ["fork", "source"]);
});

test("a lost-response fork without inherited labels is recovered through its private manifest", async () => {
  const api = new Provider(); api.ambiguousFork = true;
  await assert.rejects(captured(api), /response lost/);
  const fork = await api.getSandbox("fork"); assert.ok(fork); fork.labels = {};
  await finalizePreviewHandoffs(owner, api, { cleanupOnly: true });
  assert.deepEqual(api.deleted, ["fork", "source"]);
});

test("rejected fork deletion preserves source; another job can recover", async () => {
  const api = new Provider(); await captured(api); api.failDelete = true;
  await assert.rejects(finalizePreviewHandoffs(owner, api), /Optional preview/);
  assert.ok(api.sandboxes.has("source")); api.failDelete = false;
  await finalizePreviewHandoffs(owner, api, { cleanupOnly: true });
  assert.deepEqual(api.deleted, ["fork", "source"]);
});

test("cancellation before capture cleans source; unrelated SHA/owner are untouched", async () => {
  const api = new Provider(); await ownPreviewSource("source", owner, api);
  await finalizePreviewHandoffs({ ...owner, sourceSha: "c".repeat(40) }, api, { cleanupOnly: true });
  assert.equal(api.deleted.length, 0);
  await finalizePreviewHandoffs(owner, api, { cleanupOnly: true }); assert.deepEqual(api.deleted, ["source"]);
});

test("durable fork/save requests never replay ambiguous provider responses", async () => {
  let requests = 0;
  const api = new DaytonaApi({ apiKey: "test", apiUrl: "https://test.invalid", region: "test" }, async () => { requests++; throw new Error("response lost"); });
  await assert.rejects(api.snapshotSandboxOnce("fork", "checkpoint", true), /response lost/); assert.equal(requests, 1);
  await assert.rejects(api.forkSandbox("source", "fork", { retry: false }), /response lost/); assert.equal(requests, 2);
});

test("delete acknowledgement is not fork release; poll through destroying before proceeding", async () => {
  let reads = 0;
  const api = new DaytonaApi({ apiKey: "test", apiUrl: "https://test.invalid", region: "test" }, async () => {
    reads++;
    return reads === 1 ? Response.json({ id: "fork", state: "destroying", labels: {} }) : new Response("", { status: 404 });
  });
  await api.waitForSandboxDeleted("fork", 10); assert.equal(reads, 2);
});

test("a crashed finalizer's request marker forbids replay even before snapshot visibility", async () => {
  const api = new Provider(); const capture = await captured(api);
  const source = await api.getSandbox("source"); assert.ok(source);
  source.labels.previewSaveRequested = capture.checkpoint.id; api.failWait = true;
  await assert.rejects(finalizePreviewHandoffs(owner, api, { timeoutMs: 1 }), /Optional preview/);
  assert.equal(api.requested, 0); assert.deepEqual(api.deleted, ["fork", "source"]);
});

test("accepted snapshot resumes without duplicate request", async () => {
  const api = new Provider(); const capture = await captured(api);
  await api.snapshotSandbox("fork", capture.checkpoint.id);
  await finalizePreviewHandoffs(owner, api); assert.equal(api.requested, 1);
});

test("recovery can release a stopped source and fork without relying on guest files", async () => {
  const api = new Provider(); await captured(api);
  const source = await api.getSandbox("source"); const fork = await api.getSandbox("fork"); assert.ok(source && fork);
  source.state = "stopped"; fork.state = "stopped"; api.files.clear();
  await finalizePreviewHandoffs(owner, api, { cleanupOnly: true });
  assert.deepEqual(api.deleted, ["fork", "source"]);
});

test("ambiguous snapshot response is reconciled by name without a second POST", async () => {
  class AmbiguousSave extends Provider {
    override async snapshotSandboxOnce(id: string, name: string) { await super.snapshotSandboxOnce(id, name); throw new Error("response lost"); }
  }
  const api = new AmbiguousSave(); await captured(api);
  const result = await finalizePreviewHandoffs(owner, api);
  assert.equal(result[0]?.ready, true); assert.equal(api.requested, 1);
});

test("mismatched fork manifest refuses publication and deletion", async () => {
  const api = new Provider(); await captured(api);
  api.files.get("fork")?.set("/opt/openwork-preview/checkpoint.json", "{}");
  await assert.rejects(finalizePreviewHandoffs(owner, api), /Optional preview/);
  assert.equal(api.requested, 0); assert.equal(api.deleted.length, 0);
});

test("a separate finalizer process owns save and teardown after the producer exits, without hanging timers", { timeout: 15_000 }, async () => {
  const api = new Provider();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://provider.test");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (parts[0] === "toolbox" && parts[2] === "toolbox") parts.splice(2, 1);
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      let value: unknown;
      if (parts[0] === "toolbox") {
        const source = await api.getSandbox(parts[1]); assert.ok(source);
        const path = url.searchParams.get("path") ?? "";
        if (parts[2] === "files" && parts[3] === "download") {
          const text = await api.readFile(source, path);
          res.writeHead(text === null ? 404 : 200); res.end(text); return;
        }
        if (parts[2] === "files") {
          const content = /\r\n\r\n([\s\S]*)\r\n--/.exec(body)?.[1]; assert.ok(content);
          await api.writeFile(source, path, content);
        }
        value = { exitCode: 0, result: "" };
      } else if (parts[0] === "sandbox") {
        const payload: unknown = body ? JSON.parse(body) : {};
        assert.ok(object(payload));
        if (parts.length === 1) value = await api.listSandboxes(labelMap(JSON.parse(url.searchParams.get("labels") ?? "{}")));
        else if (req.method === "DELETE") { await api.deleteSandbox(parts[1]); value = null; }
        else if (parts[2] === "labels") { await api.setLabels(parts[1], labelMap(payload.labels)); value = null; }
        else if (parts[2] === "fork") { assert.ok(typeof payload.name === "string"); value = await api.forkSandbox(parts[1], payload.name); }
        else if (parts[2] === "snapshot") { assert.ok(typeof payload.name === "string"); await api.snapshotSandbox(parts[1], payload.name); value = null; }
        else value = await api.getSandbox(parts[1]);
      } else if (parts[0] === "snapshots") {
        value = await api.getSnapshot(parts[1]);
        if (value) value = await api.waitForSnapshot(parts[1]);
      } else throw new Error("Unexpected provider route");
      res.writeHead(value === null && req.method === "GET" ? 404 : 200, { "content-type": "application/json" }); res.end(JSON.stringify(value));
    } catch (error) { res.writeHead(400); res.end(JSON.stringify({ message: String(error) })); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const port = address.port;
  async function processRun(code: string) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, DAYTONA_API_KEY: "test", DAYTONA_API_URL: `http://127.0.0.1:${port}` }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    const status = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(status, 0, output);
  }
  const imports = `import { ownPreviewSource, capturePreviewHandoff, finalizePreviewHandoffs } from ${JSON.stringify(new URL("./handoff.ts", import.meta.url).href)}; const owner = ${JSON.stringify(owner)};`;
  try {
    await processRun(`${imports} await ownPreviewSource("source", owner); await capturePreviewHandoff("source", "${"b".repeat(64)}", owner);`);
    assert.equal(api.requested, 0); assert.ok(api.sandboxes.has("source")); assert.ok(api.sandboxes.has("fork"));
    await processRun(`${imports} const result = await finalizePreviewHandoffs(owner); if (!result[0]?.ready) throw new Error("not ready");`);
    assert.equal(api.requested, 1); assert.deepEqual(api.deleted, ["fork", "source"]);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
