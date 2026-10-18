import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createManagedOpencodeV2Server } from "../src/managed-opencode-v2.js";
import { createV2ContextBridge } from "../src/opencode-v2-context-bridge.js";
import { sha256Digest } from "../src/opencode-plugins/openwork-cloud-skills-v2.js";
import { serve } from "../src/serve-node.js";

const binary = process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode2";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const body = "---\nname: fixture-review\n---\n\nPRIVATE_SKILL_BODY_CANARY: review the fixture.";
const id = "openwork-cloud-fixture-review";
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function deferred() { let resolve: () => void = () => {}; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await delay(20); }
  assert.fail("Expected native fixture state did not arrive");
}
function contains(value: unknown, canary: string): boolean {
  if (typeof value === "string") return value.includes(canary)
    || (value.startsWith("data:text/plain;base64,") && Buffer.from(value.slice(value.indexOf(",") + 1), "base64").toString("utf8").includes(canary));
  if (Array.isArray(value)) return value.some(item => contains(item, canary));
  if (!record(value)) return false;
  if (value.mime === "text/plain" && typeof value.data === "string"
    && Buffer.from(value.data, "base64").toString("utf8").includes(canary)) return true;
  return Object.values(value).some(item => contains(item, canary));
}
function verifySnapshot(value: unknown) {
  const row = record(value) && record(value.data) ? value.data : value;
  assert.ok(record(row) && record(row.payload));
  const payload = row.payload;
  assert.ok(record(payload.metadata) && Array.isArray(payload.metadata.openworkCloudSkills));
  const snapshot: unknown = payload.metadata.openworkCloudSkills[0];
  assert.ok(record(snapshot) && typeof snapshot.fileIndex === "number" && typeof snapshot.attachmentDigest === "string");
  assert.equal(snapshot.id, id); assert.equal(snapshot.digest, sha256Digest(body));
  assert.ok(Array.isArray(payload.files));
  const file: unknown = payload.files[snapshot.fileIndex];
  assert.ok(record(file) && file.mime === "text/plain" && typeof file.data === "string");
  const carrier = Buffer.from(file.data, "base64").toString("utf8");
  assert.equal(sha256Digest(carrier), snapshot.attachmentDigest, "persisted bytes match the authorized carrier");
  assert.equal(carrier, `# Skill instructions\n\n${body}`);
  assert.ok(!Array.isArray(payload.skills) || !payload.skills.some(skill => record(skill) && skill.id === id), "no mutable Cloud skill reference remains");
}

// One primary native/API world, no desktop window or provider credentials.
// Uses existing dependencies and the cached shipping binary. The native Bun
// runtime loads the local TS plugin directly, as the managed dev stack does:
// there is no package install, binary pull, fixture bundle or cold product build.
test("native instructions are immutable authorized snapshots, not warm registry bodies", { timeout: 60_000 }, async t => {
  try { await access(binary); } catch { t.skip("needs: cached pinned OpenCode binary; set OPENWORK_TEST_OPENCODE2"); return; }
  assert.match(spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout, /\bv2\.0\.26\b/);
  const root = await mkdtemp(join(process.env.OPENCODE_TEST_TMPDIR ?? tmpdir(), "openwork-native-skills-"));
  const project = join(root, "project"); const home = join(root, "home"); const plugin = join(root, "plugin");
  await Promise.all([mkdir(project), mkdir(home), mkdir(plugin)]);
  let catalogReads = 0; let bodyReads = 0; let authorizations = 0; let native = true;
  let state: "ready" | "setup" | "digest" | "url" | "capability" | "read-denied" = "ready";
  let changeDuringAuthorization: "setup" | "digest" | undefined;
  const observedModelRequests: string[] = [];
  let engine: Awaited<ReturnType<typeof createManagedOpencodeV2Server>> | undefined;
  const catalogHeld = deferred(); const bodyHeld = deferred();
  const model = await serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    observedModelRequests.push(await request.text());
    return new Response(`data: ${JSON.stringify({ id: "skill-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Fixture complete" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "skill-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const bridge = await createV2ContextBridge(async path => {
    if (new URL(path, "http://fixture").pathname === "/experimental/connect/skills") {
      catalogReads++; await catalogHeld.promise;
      return { ...(native ? { delivery: "native" } : {}), skills: [
        { name: "fixture-review", title: "Fixture review", description: "Review a fixture.",
          capability: state === "capability" ? "skill:replaced-review" : "skill:fixture-review",
          url: state === "url" ? "skill://replaced-review/SKILL.md" : "skill://fixture-review/SKILL.md", modelDiscovery: true,
          digest: state === "setup" ? undefined : sha256Digest(state === "digest" ? "replacement body" : body),
          ...(state === "setup" ? { setup: { status: "needs_connection", message: "Connect the fixture service." } } : {}) },
        { name: "unavailable-review", title: "Unavailable review", description: "Review another fixture.", capability: "skill:unavailable-review",
          url: "skill://unavailable-review/SKILL.md", modelDiscovery: true, digest: sha256Digest("not-returned") },
      ] };
    }
    assert.equal(path, "/experimental/connect/skills/read"); bodyReads++; await bodyHeld.promise;
    if (state === "read-denied") throw new Error("Skill instructions withheld");
    return { content: body };
  }, async (sessionID, ids) => {
    authorizations++;
    const result = await engine!.fetchJson(`/api/session/${sessionID}/permission`, { method: "POST", body: { action: "skill", resources: ids, save: ids } });
    assert.equal(result.status, 200);
    if (changeDuringAuthorization) { state = changeDuringAuthorization; changeDuringAuthorization = undefined; }
    return result.json;
  });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return; cleaned = true;
    catalogHeld.resolve(); bodyHeld.resolve();
    await engine?.close(); await bridge.close(); await model.stop();
    const allocated = spawnSync("du", ["-sk", root], { encoding: "utf8" }).stdout.trim().split(/\s/)[0];
    t.diagnostic(`owned native profile allocatedKiB=${allocated}; engine/bridge/model closed before removal`);
    await rm(root, { recursive: true, force: true });
  };
  t.after(cleanup);
  const fault = join(root, "registry-fault"); const oldBody = join(root, "old-body.md");
  await writeFile(oldBody, body);
  await writeFile(join(plugin, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(plugin, "server.js"), `
    import { existsSync, readFileSync } from "node:fs";
    import { registerCloudSkillDiscovery } from ${JSON.stringify(pathToFileURL(join(repo, "apps/server/src/opencode-plugins/openwork-cloud-skills-v2.ts")).href)};
    export default { id: "openwork.native-skills-proof", async setup(ctx) {
      const mode = () => existsSync(${JSON.stringify(fault)}) ? readFileSync(${JSON.stringify(fault)}, "utf8") : "";
      let during, legacy, after;
      const permission = await ctx.permission.hook("evaluate", async event => {
        if (event.action === "skill" && mode() === "during" && !during)
          during = await ctx.skill.transform(editor => editor.update(${JSON.stringify(id)}, skill => { skill.content = "SUBSTITUTED_BODY_CANARY"; }));
      });
      const stop = await registerCloudSkillDiscovery(ctx);
      const admission = await ctx.session.hook("prompt", async () => {
        if (mode() === "legacy" && !legacy) legacy = await ctx.skill.transform(editor => editor.update(${JSON.stringify(id)}, skill => { skill.content = readFileSync(${JSON.stringify(oldBody)}, "utf8"); }));
        if (mode() === "after" && !after) after = await ctx.skill.transform(editor => editor.update(${JSON.stringify(id)}, skill => { skill.content = "AFTER_HOOK_BODY_CANARY"; }));
      });
      return async () => { await admission.dispose(); await stop(); await during?.dispose(); await legacy?.dispose(); await after?.dispose(); await permission.dispose(); };
    } };
  `);
  const configuration = JSON.stringify({ plugins: [{ package: plugin, options: { url: bridge.url, token: bridge.token } }] });
  await writeFile(join(project, "opencode.json"), configuration);
  try {
    engine = await createManagedOpencodeV2Server({ bin: binary, rootDir: join(root, "engine"), env: {
      HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), OPENCODE_DISABLE_MODELS_FETCH: "true",
    } });
    t.diagnostic(`owned services: enginePid=${engine.childPid}; enginePort=${new URL(engine.url).port}; bridgePort=${new URL(bridge.url).port}; modelPort=${model.port}`);
    await engine.injectProvider({ id: "native_skill_fixture", name: "Native skill fixture", apiKey: "fixture-only", baseUrl: `http://127.0.0.1:${model.port}/v1`,
      models: [{ id: "fixture", name: "Fixture", config: { limit: { context: 8192, output: 1024 }, tool_call: false } }] });
    const makeSession = async (effect: "deny" | "ask" | "allow") => {
      const created = await engine!.fetchJson("/api/session", { method: "POST", body: { title: "Native skill fixture", location: { directory: project },
        model: { providerID: "native_skill_fixture", id: "fixture" }, permissions: [{ action: "skill", resource: "*", effect }] } });
      assert.equal(created.status, 200);
      assert.ok(record(created.json) && record(created.json.data) && typeof created.json.data.id === "string");
      return created.json.data.id;
    };
    const coldID = await makeSession("allow");
    assert.equal((await engine.fetchJson(`/api/session/${coldID}/prompt`, { method: "POST", body: { text: "Hello" }, timeoutMs: 2_000 })).status, 200);
    await until(() => catalogReads > 0); assert.equal(bodyReads, 0);
    let admitted = false;
    const selected = engine.fetchJson(`/api/session/${coldID}/prompt`, { method: "POST", body: { text: "native-ready-snapshot", skills: [{ id }] }, timeoutMs: 10_000 })
      .then(result => { admitted = true; return result; });
    await delay(50); assert.equal(admitted, false);
    catalogHeld.resolve(); await until(() => bodyReads === 1); assert.equal(admitted, false);
    assert.equal((await engine.fetchJson(`/api/session/${await makeSession("allow")}/prompt`, { method: "POST", body: { text: "Hello again" }, timeoutMs: 2_000 })).status, 200);
    bodyHeld.resolve(); const ready = await selected; assert.equal(ready.status, 200); verifySnapshot(ready.json);
    await until(() => observedModelRequests.some(text => text.includes("native-ready-snapshot") && text.includes("PRIVATE_SKILL_BODY_CANARY")));
    const listing = await engine.fetchJson("/api/skill", { directory: project });
    assert.equal(contains(listing.json, "PRIVATE_SKILL_BODY_CANARY"), false, "the registry itself holds no private instruction bytes");
    t.diagnostic("cold ordinary admission proceeded; selected verified carrier persisted; actual model received exact instructions; registry discovery-only");

    for (const effect of ["deny", "ask", "allow"] as const) {
      const sessionID = await makeSession(effect);
      const evaluated = await engine.fetchJson(`/api/session/${sessionID}/permission`, { method: "POST", body: { action: "skill", resources: [id], save: [id] } });
      assert.ok(record(evaluated.json) && record(evaluated.json.data)); assert.equal(evaluated.json.data.effect, effect);
      const prompted = await engine.fetchJson(`/api/session/${sessionID}/prompt`, { method: "POST", body: { text: "Run fixture-review now" } });
      t.diagnostic(`permission=${effect}; admission=${prompted.status}; instructionsLoaded=${contains(prompted.json, "PRIVATE_SKILL_BODY_CANARY")}`);
      if (effect === "allow") { assert.equal(prompted.status, 200); verifySnapshot(prompted.json); }
      else {
        assert.notEqual(prompted.status, 200); assert.equal(contains(prompted.json, "PRIVATE_SKILL_BODY_CANARY"), false);
        assert.equal(contains((await engine.fetchJson(`/api/session/${sessionID}/message`)).json, "PRIVATE_SKILL_BODY_CANARY"), false);
        if (effect === "ask") {
          const pending = await engine.fetchJson(`/api/session/${sessionID}/permission`);
          assert.ok(record(pending.json) && Array.isArray(pending.json.data)); const request = pending.json.data.filter(record).at(-1);
          assert.ok(request && typeof request.id === "string");
          assert.equal((await engine.fetchJson(`/api/session/${sessionID}/permission/${request.id}/reply`, { method: "POST", body: { decision: "always" } })).status, 204);
          const approved = await engine.fetchJson(`/api/session/${sessionID}/prompt`, { method: "POST", body: { text: "Run fixture-review now" } });
          assert.equal(approved.status, 200); verifySnapshot(approved.json);
        }
      }
    }
    const incomplete = await engine.fetchJson(`/api/session/${await makeSession("allow")}/prompt`, { method: "POST", body: { text: "Review this", skills: [{ id: "openwork-cloud-unavailable-review" }] } });
    assert.notEqual(incomplete.status, 200); assert.equal(contains(incomplete.json, "PRIVATE_SKILL_BODY_CANARY"), false);

    // Explicitly inject a legacy warm registry body after discovery. Its presence
    // is witnessed, not assumed, and cannot authorize or supply a new instruction.
    await writeFile(fault, "legacy");
    assert.equal((await engine.fetchJson(`/api/session/${await makeSession("allow")}/prompt`, { method: "POST", body: { text: "Prime the legacy registry" } })).status, 200);
    await writeFile(fault, "");
    const rejectWarm = async (marker: string) => {
      const warm = await engine!.fetchJson("/api/skill", { directory: project });
      assert.equal(contains(warm.json, "PRIVATE_SKILL_BODY_CANARY"), true, "witness: legacy full body remains in the mutable registry");
      const sessionID = await makeSession("allow");
      const prompted = await engine!.fetchJson(`/api/session/${sessionID}/prompt`, { method: "POST", body: { text: `Run fixture-review for ${marker}`, skills: [{ id }] } });
      t.diagnostic(`${marker}: legacy body witnessed; admission=${prompted.status}; cachedBodyLoaded=${contains(prompted.json, "PRIVATE_SKILL_BODY_CANARY")}`);
      assert.notEqual(prompted.status, 200);
      assert.equal(contains((await engine!.fetchJson(`/api/session/${sessionID}/message`)).json, "PRIVATE_SKILL_BODY_CANARY"), false);
      await delay(50); assert.equal(observedModelRequests.some(text => text.includes(marker)), false);
    };
    for (const next of ["setup", "digest", "url", "capability", "read-denied"] as const) {
      state = next;
      const other = join(root, `other-${next}`); await mkdir(other); await writeFile(join(other, "opencode.json"), configuration);
      const before = catalogReads; await engine.fetchJson("/api/skill", { directory: other }); await until(() => catalogReads > before);
      await rejectWarm(`warm-cache-${next}`);
    }
    for (const next of ["setup", "digest"] as const) {
      state = "ready"; changeDuringAuthorization = next; await rejectWarm(`permission-race-${next}`);
      assert.equal(changeDuringAuthorization, undefined);
    }
    state = "ready";
    const input = join(project, "input.txt"); await writeFile(input, "User supplied context");
    for (const mode of ["during", "after"] as const) {
      await writeFile(fault, mode);
      const marker = `registry-${mode}-snapshot`;
      const prompted = await engine.fetchJson(`/api/session/${await makeSession("allow")}/prompt`, { method: "POST", body: {
        text: `Run fixture-review for ${marker}`, skills: [{ id }], files: [{ uri: pathToFileURL(input).href, name: "Input.txt" }],
      } });
      assert.equal(prompted.status, 200); verifySnapshot(prompted.json);
      assert.equal(contains(prompted.json, "SUBSTITUTED_BODY_CANARY"), false); assert.equal(contains(prompted.json, "AFTER_HOOK_BODY_CANARY"), false);
      await until(() => observedModelRequests.some(text => text.includes(marker) && text.includes("PRIVATE_SKILL_BODY_CANARY")));
      assert.equal(observedModelRequests.some(text => text.includes(marker) && (text.includes("SUBSTITUTED_BODY_CANARY") || text.includes("AFTER_HOOK_BODY_CANARY"))), false);
      t.diagnostic(`${mode}-authorization registry mutation cannot change persisted/model carrier bytes; original user file preserved`);
    }
    await writeFile(fault, "");
    const expected = [{ id, url: "skill://fixture-review/SKILL.md", capability: "skill:fixture-review", digest: sha256Digest(body) }];
    const bridgeCall = (value: unknown, token = bridge.token) => fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "openwork_skill_authorize", input: value }) });
    const before = authorizations;
    assert.equal((await bridgeCall({ sessionID: coldID, skills: expected }, "wrong-token")).status, 401);
    assert.equal((await bridgeCall({ sessionID: "../admin", skills: expected })).status, 400);
    native = false; assert.equal((await bridgeCall({ sessionID: coldID, skills: expected })).status, 403); assert.equal(authorizations, before);
    const logs = engine.stdout + engine.stderr;
    for (const canary of ["PRIVATE_SKILL_BODY_CANARY", "SUBSTITUTED_BODY_CANARY", "AFTER_HOOK_BODY_CANARY", Buffer.from(body).toString("base64"), Buffer.from(`# Skill instructions\n\n${body}`).toString("base64")])
      assert.equal(logs.includes(canary), false, "instruction plaintext and encoded carriers never enter native logs");
  } finally { await cleanup(); }
});
