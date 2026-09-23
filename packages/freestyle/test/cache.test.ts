import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Freestyle } from "freestyle";
import { compiledFingerprint, runningFingerprint, dependencyFingerprint, ensureLayer, sourceTree, startBuildUnit, type BuildStage } from "../src/cache.ts";

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


test("an interrupted build launch is retried through a guarded unit, and bounded", async () => {
  let calls = 0;
  let alwaysInterrupted = false;
  const api = new Freestyle({ apiKey: "synthetic", fetch: async (_input, init) => {
    calls++;
    const body: unknown = JSON.parse(String(init?.body));
    assert.ok(body && typeof body === "object" && "command" in body && typeof body.command === "string");
    assert.match(body.command, /test -f .*world.ready/);
    assert.match(body.command, /systemctl is-active --quiet openwork-world.service/);
    return Response.json({ statusCode: alwaysInterrupted || calls === 1 ? null : 0, stdout: "" });
  } });
  await startBuildUnit(api.vms.ref("builder"), "world");
  assert.equal(calls, 2);
  calls = 0;
  alwaysInterrupted = true;
  await assert.rejects(startBuildUnit(api.vms.ref("builder"), "world"), /could not start after resume/);
  assert.equal(calls, 3);
});


test("running templates only survive frontend edits; backend, seed and controller changes invalidate", () => {
  const source = ["apps/app/src/main.tsx", "ee/apps/den-web/components/nav.tsx", "ee/apps/den-web/app/api/den/route.ts", "apps/server/src/cli.ts", "ee/apps/den-api/src/auth.ts", "ee/packages/den-db/src/schema.ts", "worlds/acme-web.ts", "evals/packages/env/src/den.ts", "packages/freestyle/src/desktop.mjs", "pnpm-lock.yaml"].map((path) => entry(path));
  const before = runningFingerprint(source);
  for (const [index, item] of source.entries()) {
    const changed = runningFingerprint(source.map((value) => value === item ? { ...value, sha: "b".repeat(40) } : value));
    if (index < 2) assert.equal(changed, before, item.path);
    else assert.notEqual(changed, before, item.path);
  }
});

test("manifest test commands preserve every layer while install and runtime inputs invalidate", async () => {
  const { manifestFingerprints } = await import("../src/cache.ts");
  const original = { name: "demo", dependencies: { library: "1" }, scripts: { test: "test old", build: "compile", postinstall: "setup" } };
  const before = manifestFingerprints(original);
  assert.deepEqual(manifestFingerprints({ ...original, scripts: { ...original.scripts, test: "test new", "test:unit": "more tests" } }), before);
  assert.notEqual(manifestFingerprints({ ...original, dependencies: { library: "2" } }).installSha, before.installSha);
  const build = manifestFingerprints({ ...original, scripts: { ...original.scripts, build: "compile new" } });
  assert.equal(build.installSha, before.installSha);
  assert.notEqual(build.runtimeSha, before.runtimeSha);
  const tree = [entry("pnpm-lock.yaml"), { ...entry("apps/app/package.json"), ...before }];
  const after = [tree[0], { ...tree[1], sha: "b".repeat(40) }];
  assert.equal(dependencyFingerprint(tree), dependencyFingerprint(after));
  assert.equal(compiledFingerprint(tree), compiledFingerprint(after));
  assert.equal(runningFingerprint(tree), runningFingerprint(after));
});

test("Den changes preserve app-web code layers but invalidate ACME services", () => {
  const tree = [entry("apps/server/src/main.ts"), entry("ee/apps/den-api/src/auth.ts")];
  const after = [tree[0], entry(tree[1].path, "b".repeat(40))];
  assert.equal(compiledFingerprint(tree, "app-web"), compiledFingerprint(after, "app-web"));
  assert.equal(runningFingerprint(tree, "app-web"), runningFingerprint(after, "app-web"));
  assert.notEqual(runningFingerprint(tree, "acme-web"), runningFingerprint(after, "acme-web"));
  const shared = [entry(tree[0].path, "b".repeat(40)), tree[1]];
  assert.notEqual(runningFingerprint(tree, "app-web"), runningFingerprint(shared, "app-web"));
});

test("source tree parses manifests without executing them and fails closed on missing inputs", async () => {
  const tree = { truncated: false, tree: [entry("pnpm-lock.yaml"), entry("package.json")] };
  const result = await sourceTree(sha, async (url) => String(url).includes("raw.githubusercontent.com")
    ? Response.json({ name: "demo", scripts: { postinstall: "must not execute" } }) : Response.json(tree));
  assert.ok(result[1].installSha);
  await assert.rejects(sourceTree(sha, async (url) => String(url).includes("raw.githubusercontent.com")
    ? new Response(null, { status: 404 }) : Response.json(tree)), /Could not read package inputs/);
});

test("snapshot publication does not wait for provider deletion", async () => {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const events: BuildStage[] = [];
  const api = new Freestyle({ apiKey: "synthetic", fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "DELETE") { await pending; return new Response(null, { status: 204 }); }
    if (path.startsWith("/v5/snapshots/")) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    if (path === "/v5/vms") return Response.json({ id: "builder" });
    if (path.endsWith("/exec-await")) return Response.json({ statusCode: 0, stdout: "" });
    if (path.endsWith("/snapshot")) return Response.json({ snapshotId: "snapshot", snapshot: { id: "snapshot" } });
    throw new Error(path);
  } });
  try {
    const result = await Promise.race([
      ensureLayer({ slug: "slow-delete", stage: "tools", parent: async () => "base", prepare: async () => {}, observe: (event) => events.push(event) }, api),
      delay(1000).then(() => { throw new Error("Deletion blocked snapshot publication"); }),
    ]);
    assert.equal(result.id, "snapshot");
    assert.equal(events.some((event) => event.stage === "tools-cleanup"), false);
  } finally { release(); }
  await delay(10);
  assert.ok(events.some((event) => event.stage === "tools-cleanup"));
});
