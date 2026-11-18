import { expect, test } from "vitest";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "../src/serve-node.js";
import type { ServerConfig } from "../src/types.js";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

// Real server setting route + pinned sidecar restart. Den/models/inference are
// loopback fixtures; no production identity, key, model or VM is used.
test.skipIf(process.env.OPENWORK_TEST_SANDBOX_NATIVE !== "1")("setting applies both isolation directions, preserves active work, and never initializes hostile project plugins before restart", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sandbox-setting-native-")));
  const safe = join(root, "safe");
  const hostile = join(root, "hostile");
  await mkdir(safe); await mkdir(join(hostile, ".opencode", "plugins"), { recursive: true });
  const imported = join(root, "host-plugin-imported");
  await writeFile(join(hostile, ".opencode", "plugins", "hostile.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(imported)}, "module imported"); export default { id: "hostile-transition-fixture", setup() {} };`);
  const offered: string[][] = [];
  let organizationRequiresSandbox = false;
  const fixture = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/features" || path === "/v1/org") return Response.json({ features: { sandboxTools: true } });
    if (path === "/v1/me/desktop-config") return Response.json({ agentPermissions: { rules: [{ action: "host_execution", resource: "*", effect: organizationRequiresSandbox ? "deny" : "allow", source: "Everyone" }] } });
    if (path === "/models/api.json") return Response.json({});
    if (path === "/v1/chat/completions") {
      const body: unknown = await request.json();
      offered.push(record(body) && Array.isArray(body.tools) ? body.tools.filter(record).flatMap(tool => record(tool.function) && typeof tool.function.name === "string" ? [tool.function.name] : []).sort() : []);
      const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "gpt-6.1-sol", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return new Response(chunk({ role: "assistant", content: "transition complete" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(null, { status: 404 });
  } });
  const env = {
    HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home", "config"), XDG_DATA_HOME: join(root, "home", "data"), XDG_CACHE_HOME: join(root, "home", "cache"), XDG_STATE_HOME: join(root, "home", "state"),
    OPENWORK_RUNTIME_DB: join(root, "state", "runtime.sqlite"), OPENCODE_DB: join(root, "state", "history.db"), OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode2",
    OPENWORK_ENGINE_V2_PREVIEW: "1", OPENWORK_ENGINE_V2_CHAT: "1", OPENCODE_MODELS_URL: `http://127.0.0.1:${fixture.port}/models`,
  };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "transition-client", hostToken: "transition-host", configPath: join(root, "state", "server.json"),
    trustedDenOrigin: `http://127.0.0.1:${fixture.port}`, approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "safe", name: "Safe", path: safe, preset: "starter", workspaceType: "local" }], authorizedRoots: [root], readOnly: false,
    engineAutoUpgrade: false, freshInstallEngine: "v2", startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  const { writeGlobalRuntimeOpencodeConfig } = await import("../src/runtime-opencode-config-store.js");
  await writeGlobalRuntimeOpencodeConfig(config, () => ({ provider: { transition_fixture: {
    name: "Transition fixture", npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${fixture.port}/v1`, apiKey: "fixture-not-a-key" },
    models: { "gpt-6.1-sol": { name: "gpt-6.1-sol", tool_call: true, limit: { context: 128_000, output: 4_096 } } },
  } } }));
  const { startServer } = await import("../src/server.js");
  const server = await startServer(config);
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };
  const request = (path: string, method = "GET", body?: unknown) => fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const status = async () => { const response = await request("/experimental/engine-v2-preview/status"); const value: unknown = await response.json(); if (!record(value)) throw new Error("Invalid engine status"); return value; };
  const pid = async () => {
    for (let attempt = 0; attempt < 200; attempt++) { const value = await status(); if (value.running === true && typeof value.pid === "number") return value.pid; await delay(50); }
    throw new Error("Native sidecar did not become ready");
  };
  try {
    const originalPid = await pid();
    const created = await (await request("/workspace/safe/opencode2/api/session", "POST", { title: "Unrelated running work" })).json();
    expect(record(created) && record(created.data) && typeof created.data.id === "string").toBe(true);
    const sessionId = created.data.id;
    const started = join(root, "task-started"); const survived = join(root, "task-survived");
    const task = request(`/workspace/safe/opencode2/api/session/${sessionId}/shell`, "POST", { command: `printf started > '${started}'; sleep 2; printf survived > '${survived}'` });
    for (let attempt = 0; attempt < 200 && !await access(started).then(() => true, () => false); attempt++) await delay(25);
    await access(started);
    const busy = await request("/workspace/safe/sandbox-settings", "PUT", { allowHostExecution: false });
    expect(busy.status, await busy.clone().text()).toBe(409);
    expect(await pid()).toBe(originalPid);
    expect(await (await request("/workspace/safe/sandbox-settings")).json()).toMatchObject({ allowHostExecution: true });
    await task;
    for (let attempt = 0; attempt < 200 && !await access(survived).then(() => true, () => false); attempt++) await delay(25);
    expect(await readFile(survived, "utf8")).toBe("survived");
    let idle = false;
    let lastActivity: unknown;
    for (let attempt = 0; attempt < 200 && !idle; attempt++) {
      const active: unknown = await (await request("/workspace/safe/opencode2/api/session/active")).json();
      const jobs: unknown = await (await request("/workspace/safe/opencode2/api/experimental/job?status=running")).json();
      lastActivity = { active, jobs };
      idle = record(active) && record(active.data) && Object.keys(active.data).length === 0
        && record(jobs) && Array.isArray(jobs.data) && jobs.data.length === 0;
      if (!idle) await delay(25);
    }
    expect(idle, JSON.stringify(lastActivity)).toBe(true);
    // Do not open the hostile location in the old project-enabled process.
    config.workspaces.push({ id: "hostile", name: "Hostile", path: hostile, preset: "starter", workspaceType: "local" });
    const setting = await request("/workspace/hostile/sandbox-settings", "PUT", { allowHostExecution: false });
    expect(setting.status, await setting.clone().text()).toBe(200);
    expect(await setting.json()).toEqual({ allowHostExecution: false, effectiveAllowHostExecution: false, managed: false, featureEnabled: true });
    const isolatedPid = await pid(); expect(isolatedPid).not.toBe(originalPid);
    const plugins = await request("/workspace/hostile/opencode2/api/agent");
    expect(plugins.status, await plugins.clone().text()).toBe(200);
    await delay(500); await expect(access(imported)).rejects.toThrow();
    offered.length = 0;
    const next = await (await request("/workspace/hostile/opencode2/api/session", "POST", { title: "Usable isolated turn", model: { providerID: "transition_fixture", id: "gpt-6.1-sol" } })).json();
    const prompt = await request(`/workspace/hostile/opencode2/api/session/${next.data.id}/prompt`, "POST", { text: "Say transition complete." });
    expect(prompt.status, await prompt.clone().text()).toBe(200);
    for (let attempt = 0; attempt < 200 && offered.length === 0; attempt++) await delay(25);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every(tools => JSON.stringify(tools) === JSON.stringify(["edit", "glob", "grep", "read", "shell", "write"]))).toBe(true);
    // Wait for the new turn to end before restoring ordinary discovery.
    for (let attempt = 0; attempt < 200; attempt++) {
      const active = await (await request("/workspace/safe/opencode2/api/session/active")).json();
      if (record(active) && record(active.data) && Object.keys(active.data).length === 0) break;
      await delay(25);
    }
    const restore = await request("/workspace/hostile/sandbox-settings", "PUT", { allowHostExecution: true });
    expect(restore.status, await restore.clone().text()).toBe(200);
    expect(await pid()).not.toBe(isolatedPid);
    // Explicit ordinary mode must really re-enable project discovery.
    expect((await request("/workspace/hostile/opencode2/api/agent")).status).toBe(200);
    for (let attempt = 0; attempt < 200 && !await access(imported).then(() => true, () => false); attempt++) await delay(25);
    expect(await readFile(imported, "utf8")).toBe("module imported");
    // A managed requirement must use the same automatic admission path even
    // when the member's local preference remains Allow.
    const managed = join(root, "managed"); const managedMarker = join(root, "managed-plugin-imported");
    await mkdir(join(managed, ".opencode", "plugins"), { recursive: true });
    await writeFile(join(managed, ".opencode", "plugins", "hostile.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(managedMarker)}, "imported"); export default { id: "managed-hostile-fixture", setup() {} };`);
    config.workspaces.push({ id: "managed", name: "Managed", path: managed, preset: "starter", workspaceType: "local" });
    const { managedDesktopPolicy } = await import("../src/managed-desktop-policy.js");
    const policy = managedDesktopPolicy(config);
    organizationRequiresSandbox = true;
    await policy.setSession({ baseUrl: `http://127.0.0.1:${fixture.port}`, orgId: "transition_fixture_org", token: "fixture-token" });
    await policy.current();
    const ordinaryPid = await pid();
    expect((await request("/workspace/managed/opencode2/api/agent")).status).toBe(200);
    const managedPid = await pid(); expect(managedPid).not.toBe(ordinaryPid);
    await delay(300); await expect(access(managedMarker)).rejects.toThrow();
    expect(await (await request("/workspace/managed/sandbox-settings")).json()).toMatchObject({ allowHostExecution: true, effectiveAllowHostExecution: false, managed: true });
    // Verified ordinary authority restores project discovery automatically on
    // the next read, with no setting rewrite or hidden restart action.
    organizationRequiresSandbox = false;
    await policy.current();
    expect((await request("/workspace/managed/opencode2/api/agent")).status).toBe(200);
    expect(await pid()).not.toBe(managedPid);
    for (let attempt = 0; attempt < 200 && !await access(managedMarker).then(() => true, () => false); attempt++) await delay(25);
    expect(await readFile(managedMarker, "utf8")).toBe("imported");
  } finally {
    await server.stop(); await fixture.stop();
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
