import assert from "node:assert/strict";
import test from "node:test";
import { Freestyle } from "freestyle";
import { deletePreview, findSnapshot, launchPreview, snapshotSlug } from "../src/index.ts";
import { ensureSnapshot } from "../src/builder.ts";

const sha = "a".repeat(40);
function mockApi() {
  const creates: Record<string, unknown>[] = [];
  const writes: string[] = [];
  const deleted: string[] = [];
  const api = new Freestyle({ apiKey: "synthetic", fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.startsWith("/v5/snapshots/")) return Response.json({ id: "sh-template", slug: snapshotSlug(sha) });
    if (path === "/v5/vms" && init?.method === "POST") {
      const body: unknown = JSON.parse(String(init.body));
      assert.ok(typeof body === "object" && body !== null && !Array.isArray(body));
      creates.push(Object.fromEntries(Object.entries(body)));
      return Response.json({ id: `vm-${creates.length}`, createdAt: new Date().toISOString() });
    }
    if (path.includes("/fs/")) { writes.push(String(init?.body)); return Response.json({}); }
    if (path.endsWith("/exec-await")) return Response.json({ statusCode: 0, stdout: "" });
    if (init?.method === "DELETE") { deleted.push(path); return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected provider request ${init?.method} ${path}`);
  } });
  return { api, creates, writes, deleted };
}

const reachable: typeof fetch = async () => new Response(null, { status: 303, headers: { "set-cookie": "__Host-openwork-preview=synthetic" } });

test("concurrent launches from one report get separate VMs, credentials and provider expiry", async () => {
  const { api, creates, writes } = mockApi();
  const [first, second] = await Promise.all([
    launchPreview({ gitSha: sha, reportId: "b".repeat(32) }, api, reachable),
    launchPreview({ gitSha: sha, reportId: "b".repeat(32) }, api, reachable),
  ]);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.url, second.url);
  assert.notEqual(new URL(first.url).searchParams.get("token"), new URL(second.url).searchParams.get("token"));
  assert.equal(first.snapshotId, second.snapshotId);
  assert.ok(new URL(first.url).hostname.endsWith(".preview.openwork.software"));
  assert.equal(creates.length, 2);
  for (const body of creates) {
    assert.equal(body.snapshotId, "sh-template");
    assert.equal(body.ttlSeconds, 7200);
    assert.ok(body.tls); // Domain lifetime is bound to its VM.
  }
  assert.equal(writes.length, 2);
});

test("failed public readiness cleans up the newly allocated VM", async () => {
  const { api, deleted } = mockApi();
  await assert.rejects(launchPreview({ gitSha: sha }, api, async () => new Response(null, { status: 401 })), /could not be reached/);
  assert.deepEqual(deleted, ["/v5/vms/vm-1"]);
});

test("unknown snapshots and invalid revisions never allocate VMs", async () => {
  let calls = 0;
  const api = new Freestyle({ apiKey: "synthetic", fetch: async () => {
    calls += 1;
    return Response.json({ code: "NOT_FOUND", message: "Missing" }, { status: 404 });
  } });
  assert.throws(() => snapshotSlug("dev; echo nope"), /full pushed/);
  assert.equal(await findSnapshot(sha, api), null);
  await assert.rejects(launchPreview({ gitSha: sha }, api, reachable), /no Freestyle snapshot/);
  assert.equal(calls, 2);
});

test("cleanup refuses unrelated VMs", async () => {
  const api = new Freestyle({ apiKey: "synthetic", fetch: async (_url, init) => {
    assert.notEqual(init?.method, "DELETE");
    return Response.json({ id: "vm-unrelated", metadata: {} });
  } });
  await assert.rejects(deletePreview("vm-unrelated", api), /not owned/);
});

test("provider capacity conflicts do not masquerade as an in-progress snapshot", async () => {
  const api = new Freestyle({ apiKey: "synthetic", fetch: async (_url, init) => {
    if (init?.method === "POST") return Response.json({ code: "CONFLICT", message: "No capacity" }, { status: 409 });
    return Response.json({ code: "NOT_FOUND", message: "Missing" }, { status: 404 });
  } });
  await assert.rejects(ensureSnapshot(sha, api), /No capacity/);
});

test("an existing immutable snapshot is reused without creating a builder", async () => {
  const { api, creates } = mockApi();
  assert.equal((await ensureSnapshot(sha, api)).id, "sh-template");
  assert.equal(creates.length, 0);
});

test("snapshot identity separates worlds and rejects unknown recipes", async () => {
  const { previewWorld } = await import("../src/index.ts");
  assert.notEqual(snapshotSlug(sha, "app-web"), snapshotSlug(sha, "acme-web"));
  assert.throws(() => previewWorld("arbitrary-command"), /Unsupported/);
});

test("world outputs accept disposable credentials but reject malformed values", async () => {
  const { parsePreviewOutputs } = await import("../src/outputs.ts");
  assert.deepEqual(parsePreviewOutputs({ password: { value: "synthetic", secret: true, group: "Accounts" } }), {
    password: { value: "synthetic", secret: true, group: "Accounts" },
  });
  assert.throws(() => parsePreviewOutputs({ password: { value: {}, secret: true } }), /Invalid/);
  assert.throws(() => parsePreviewOutputs({ password: { value: "synthetic", secret: "false" } }), /Invalid/);
});
