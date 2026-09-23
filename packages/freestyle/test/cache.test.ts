import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Freestyle } from "freestyle";
import { compiledFingerprint, dependencyFingerprint, ensureLayer, sourceTree, type BuildStage } from "../src/cache.ts";

const sha = "a".repeat(40);
const entry = (path: string, hash = sha) => ({ path, sha: hash, type: "blob" });
test("dependency cache survives source edits but invalidates manifests, both locks, configuration and patches", () => {
  const inputs = [entry("pnpm-lock.yaml"), entry("evals/pnpm-lock.yaml"), entry("apps/app/package.json"),
    entry("pnpm-workspace.yaml"), entry("evals/.npmrc"), entry("patches/fix.patch"), entry("apps/app/src/main.ts")];
  const before = dependencyFingerprint(inputs);
  assert.equal(dependencyFingerprint([...inputs].reverse()), before);
  assert.equal(dependencyFingerprint(inputs.map((item) => item.path.endsWith("main.ts") ? { ...item, sha: "b".repeat(40) } : item)), before);
  for (const target of inputs.slice(0, -1)) {
    assert.notEqual(dependencyFingerprint(inputs.map((item) => item.path === target.path ? { ...item, sha: "b".repeat(40) } : item)), before, target.path);
  }
  assert.notEqual(dependencyFingerprint([...inputs, entry("packages/new/package.json")]), before);
  assert.throws(() => dependencyFingerprint([]), /missing its lockfile/);
});

test("incomplete source metadata cannot silently reuse dependencies", async () => {
  await assert.rejects(sourceTree(sha, async () => Response.json({ truncated: true, tree: [entry("pnpm-lock.yaml")] })), /Incomplete/);
  await assert.rejects(sourceTree(sha, async () => Response.json({ truncated: false, tree: [entry("pnpm-lock.yaml", "bad")] })), /Invalid/);
});

function provider() {
  let exists = false;
  let builder: Record<string, unknown> | undefined;
  let creates = 0;
  let deletes = 0;
  const api = new Freestyle({ apiKey: "synthetic", fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.startsWith("/v5/snapshots/")) return exists
      ? Response.json({ id: "snapshot", createdAt: new Date().toISOString() })
      : Response.json({ code: "NOT_FOUND", message: "Missing" }, { status: 404 });
    if (path === "/v5/vms" && init?.method === "POST") {
      if (builder) return Response.json({ code: "CONFLICT", message: "Builder exists" }, { status: 409 });
      const body: unknown = JSON.parse(String(init.body));
      assert.ok(body && typeof body === "object" && "metadata" in body);
      builder = { id: "builder", metadata: body.metadata };
      creates++;
      return Response.json(builder);
    }
    if (path.endsWith("/exec-await")) return Response.json({ statusCode: 0, stdout: "" });
    if (path.endsWith("/snapshot") && init?.method === "POST") {
      exists = true;
      return Response.json({ snapshotId: "snapshot", snapshot: { id: "snapshot", createdAt: new Date().toISOString() } });
    }
    if (init?.method === "DELETE") { builder = undefined; deletes++; return new Response(null, { status: 204 }); }
    if (path.startsWith("/v5/vms/") && builder) return Response.json(builder);
    throw new Error(`Unexpected request ${path}`);
  } });
  return { api, counts: () => ({ creates, deletes }) };
}

test("concurrent cache misses publish once and subsequent hits do no preparation", async () => {
  const { api, counts } = provider();
  let prepared = 0;
  const events: BuildStage[] = [];
  const input = { slug: "test-layer", stage: "tools", parent: async () => "base", observe: (event: BuildStage) => events.push(event),
    prepare: async () => { prepared++; await delay(30); } };
  const [first, second] = await Promise.all([ensureLayer(input, api), ensureLayer(input, api)]);
  assert.equal(first.id, second.id);
  await ensureLayer({ ...input, parent: async () => { throw new Error("Cache hit must not rebuild its parent"); } }, api);
  assert.equal(prepared, 1);
  assert.deepEqual(counts(), { creates: 1, deletes: 1 });
  assert.equal(events.filter((event) => event.cacheHit).length, 2);
});

test("a failed preparation publishes no snapshot and deletes its builder", async () => {
  const { api, counts } = provider();
  await assert.rejects(ensureLayer({ slug: "test-layer", stage: "tools", parent: async () => "base", observe: () => {},
    prepare: async () => { throw new Error("setup failed"); } }, api), /setup failed/);
  assert.deepEqual(counts(), { creates: 1, deletes: 1 });
  await assert.rejects(api.vms.snapshots.get("test-layer"));
});


test("compiled cache invalidates shared code, tools and config but not interpreted app source", () => {
  const source = ["pnpm-lock.yaml", "constants.json", "apps/server/src/cli.ts", "packages/types/src/index.ts", "scripts/build.mjs", "apps/desktop/scripts/electron-dev.mjs", "ee/packages/den-db/src/schema.ts", "apps/app/src/main.tsx", "ee/apps/den-web/src/app/page.tsx", "ee/apps/den-api/src/main.ts"].map((path) => entry(path));
  const original = compiledFingerprint(source);
  for (const item of source) {
    const changed = compiledFingerprint(source.map((value) => value === item ? { ...value, sha: "b".repeat(40) } : value));
    if (["apps/app/", "ee/apps/den-web/", "ee/apps/den-api/"].some((prefix) => item.path.startsWith(prefix))) assert.equal(changed, original, item.path);
    else assert.notEqual(changed, original, item.path);
  }
});
