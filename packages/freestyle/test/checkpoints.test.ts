import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Freestyle } from "freestyle";
import { parseEvidenceCheckpoint } from "../src/checkpoint-schema.ts";
import { CheckpointUnavailable, forkEvidenceCheckpoint, launchEvidenceWorld, deleteEvidenceVm, EVIDENCE_KIND } from "../src/checkpoints.ts";

const sourceSha = "a".repeat(40);
function checkpoint() {
  return parseEvidenceCheckpoint({ version: 1, provider: "freestyle", id: `ow-evidence-v1-${"b".repeat(32)}`, sourceSha, imageHash: "c".repeat(64),
    capturedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() });
}
function provider(manifest = checkpoint(), uniqueSlots = false) {
  const creates: Record<string, unknown>[] = [];
  const slots = new Map<string, string>();
  const removed: string[] = [];
  const files = new Map<string, string>();
  const api = new Freestyle({ apiKey: "synthetic", fetch: async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.startsWith("/v5/snapshots/")) return Response.json({ id: "snap", slug: manifest.id, public: false, createdAt: manifest.capturedAt });
    if (path === "/v5/vms" && init?.method === "POST") {
      const body: unknown = JSON.parse(String(init.body));
      assert.ok(typeof body === "object" && body !== null);
      if (uniqueSlots && "slug" in body && typeof body.slug === "string" && slots.has(body.slug)) return Response.json({ message: "Slug conflict" }, { status: 409 });
      if ("slug" in body && typeof body.slug === "string") slots.set(body.slug, `vm-${creates.length + 1}`);
      creates.push(Object.fromEntries(Object.entries(body)));
      return Response.json({ id: `vm-${creates.length}`, createdAt: new Date().toISOString() });
    }
    if (init?.method === "DELETE") { removed.push(path); return new Response(null, { status: 204 }); }
    const requested = path.split("/")[3];
    const vmId = slots.get(requested) ?? requested;
    if (path.includes("/fs/")) {
      const guestPath = url.searchParams.get("path") ?? "";
      const key = `${vmId}:${guestPath}`;
      if ((init?.method ?? "GET") !== "GET") { files.set(key, await new Response(init?.body).text()); return Response.json({}); }
      if (guestPath.endsWith("source-sha")) return new Response(sourceSha);
      if (guestPath.endsWith("evidence-ready")) return new Response("web-v1");
      if (guestPath.endsWith("checkpoint.json")) return new Response(JSON.stringify(manifest));
      return new Response(files.get(key) ?? "", { status: files.has(key) ? 200 : 404 });
    }
    if (path.startsWith("/v5/vms/")) {
      const created = creates[Number(vmId.split("-")[1]) - 1];
      return Response.json({ id: vmId, metadata: created?.metadata ?? { kind: "other", sourceSha } });
    }
    throw new Error(`Unexpected provider operation ${path}`);
  } });
  return { api, creates, removed };
}
const reachable: typeof fetch = async (input) => new URL(String(input)).pathname === "/__openwork_launch"
  ? new Response(null, { status: 303, headers: { "set-cookie": "__Host-openwork-preview=synthetic" } }) : new Response("noVNC");

test("checkpoint schema rejects malformed IDs, hashes, times, and unbounded retention", () => {
  const valid = checkpoint();
  for (const invalid of [null, { ...valid, id: "arbitrary-snapshot" }, { ...valid, sourceSha: "dev" }, { ...valid, imageHash: "invalid" },
    { ...valid, expiresAt: "invalid" }, { ...valid, expiresAt: valid.capturedAt }, { ...valid, expiresAt: new Date(Date.now() + 3 * 86400_000).toISOString() }])
    assert.throws(() => parseEvidenceCheckpoint(invalid));
  assert.deepEqual(parseEvidenceCheckpoint({ ...valid, secret: "must be stripped" }), valid);
});

test("expired checkpoint fails before any provider call", async () => {
  const value = checkpoint(); value.capturedAt = new Date(Date.now() - 7200_000).toISOString(); value.expiresAt = new Date(Date.now() - 3600_000).toISOString();
  const api = new Freestyle({ apiKey: "synthetic", fetch: async () => { assert.fail("No provider call is allowed"); } });
  await assert.rejects(forkEvidenceCheckpoint(value, "d".repeat(32), randomUUID(), api), CheckpointUnavailable);
});

test("web world launch denies egress, bounds lifetime, and rotates private viewer credentials", async () => {
  const mock = provider();
  const a = await launchEvidenceWorld("template", sourceSha, mock.api, reachable);
  const b = await launchEvidenceWorld("template", sourceSha, mock.api, reachable);
  assert.notEqual(a.url, b.url); assert.notEqual(a.cookie, b.cookie);
  assert.deepEqual(mock.creates[0].firewall, { rules: [] });
  assert.equal(mock.creates[0].ttlSeconds, 3600);
  assert.deepEqual(mock.creates[0].metadata, { kind: EVIDENCE_KIND, sourceSha });
});

test("fork validates its captured screenshot manifest and leaves the source untouched", async () => {
  const value = checkpoint(); const mock = provider(value);
  const fork = await forkEvidenceCheckpoint(value, "d".repeat(32), randomUUID(), mock.api, reachable);
  assert.match(fork.url, /^https:\/\/evidence-/);
  assert.equal(mock.creates[0].snapshotId, "snap");
  assert.deepEqual(mock.removed, []);
  const wrong = { ...value, imageHash: "e".repeat(64) };
  await assert.rejects(forkEvidenceCheckpoint(wrong, "d".repeat(32), randomUUID(), mock.api, reachable), /screenshot/);
  assert.deepEqual(mock.removed, ["/v5/vms/vm-2"]);
});

test("a retried request reuses its fork and unique provider slots cap concurrent copies", async () => {
  const value = checkpoint(); const mock = provider(value, true); const requestId = randomUUID();
  const first = await forkEvidenceCheckpoint(value, "d".repeat(32), requestId, mock.api, reachable);
  const again = await forkEvidenceCheckpoint(value, "d".repeat(32), requestId, mock.api, reachable);
  assert.equal(again.id, first.id); assert.equal(again.url, first.url); assert.equal(mock.creates.length, 1);
  await forkEvidenceCheckpoint(value, "d".repeat(32), randomUUID(), mock.api, reachable);
  await forkEvidenceCheckpoint(value, "d".repeat(32), randomUUID(), mock.api, reachable);
  await assert.rejects(forkEvidenceCheckpoint(value, "d".repeat(32), randomUUID(), mock.api, reachable), /Three forks/);
  assert.equal(mock.creates.length, 3);
});

test("failed public readiness deletes the allocated VM and unrelated VMs cannot be deleted", async () => {
  const mock = provider();
  await assert.rejects(launchEvidenceWorld("template", sourceSha, mock.api, async () => new Response(null, { status: 401 })), /readiness/);
  assert.deepEqual(mock.removed, ["/v5/vms/vm-1"]);
  await assert.rejects(deleteEvidenceVm("vm-99", mock.api), /unrelated/);
});
