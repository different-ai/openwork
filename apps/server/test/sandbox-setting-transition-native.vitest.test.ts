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
  let holdInference = false;
  let hostToolAfterHold = false;
  const continuedHostTask = join(safe, "continued-host-task");
  let releaseInference = () => {};
  let organizationRequiresSandbox = false;
  const fixture = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/features" || path === "/v1/org") return Response.json({ features: { sandboxTools: true } });
    if (path === "/v1/me/desktop-config") return Response.json({ agentPermissions: { rules: [{ action: "host_execution", resource: "*", effect: organizationRequiresSandbox ? "deny" : "allow", source: "Everyone" }] } });
    if (path === "/models/api.json") return Response.json({});
    if (path === "/v1/chat/completions") {
      const body: unknown = await request.json();
      offered.push(record(body) && Array.isArray(body.tools) ? body.tools.filter(record).flatMap(tool => record(tool.function) && typeof tool.function.name === "string" ? [tool.function.name] : []).sort() : []);
      const continueOnHost = hostToolAfterHold;
      hostToolAfterHold = false;
      if (holdInference) await new Promise<void>(resolve => { releaseInference = resolve; });
      const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "gpt-6.1-sol", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const delta = continueOnHost ? { role: "assistant", tool_calls: [{ index: 0, id: "continue-host-tool", type: "function", function: {
        name: "shell", arguments: JSON.stringify({ command: `printf 'active turn completed its next host tool' > '${continuedHostTask}'`, description: "Complete the active turn", timeout: 5_000 }),
      } }] } : { role: "assistant", content: "transition complete" };
      return new Response(chunk(delta, null) + chunk({}, continueOnHost ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
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
    const chat = await (await request("/workspace/safe/opencode2/api/session", "POST", { title: "Active ordinary chat", model: { providerID: "transition_fixture", id: "gpt-6.1-sol" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] })).json();
    holdInference = true; hostToolAfterHold = true;
    const continuingChat = request(`/workspace/safe/opencode2/api/session/${chat.data.id}/prompt`, "POST", { text: "Write the completion marker, then finish." });
    for (let attempt = 0; attempt < 200 && offered.length === 0; attempt++) await delay(25);
    expect(offered.length).toBeGreaterThan(0);
    const created = await (await request("/workspace/safe/opencode2/api/session", "POST", { title: "Unrelated running work" })).json();
    expect(record(created) && record(created.data) && typeof created.data.id === "string").toBe(true);
    const sessionId = created.data.id;
    const started = join(root, "task-started"); const survived = join(root, "task-survived");
    const task = request(`/workspace/safe/opencode2/api/session/${sessionId}/shell`, "POST", { command: `printf started > '${started}'; sleep 2; printf survived > '${survived}'` });
    for (let attempt = 0; attempt < 200 && !await access(started).then(() => true, () => false); attempt++) await delay(25);
    await access(started);
    config.workspaces.push({ id: "hostile", name: "Hostile", path: hostile, preset: "starter", workspaceType: "local" });
    const busy = await request("/workspace/safe/sandbox-settings", "PUT", { allowHostExecution: false });
    expect(busy.status, await busy.clone().text()).toBe(200);
    expect(await busy.json()).toMatchObject({ allowHostExecution: false, effectiveAllowHostExecution: true, pending: true });
    expect(await pid()).toBe(originalPid);
    expect(await (await request("/workspace/safe/sandbox-settings")).json()).toMatchObject({ allowHostExecution: false, effectiveAllowHostExecution: true, pending: true });
    // Progress/history use the global native APIs without opening a location.
    const activeWhilePending = await request("/workspace/safe/opencode2/api/session/active");
    expect(activeWhilePending.status, await activeWhilePending.clone().text()).toBe(200);
    const historyWhilePending = await request(`/workspace/safe/opencode2/api/session/${chat.data.id}/message`);
    expect(historyWhilePending.status, await historyWhilePending.clone().text()).toBe(200);
    const coldRead = await request("/workspace/hostile/opencode2/api/agent");
    expect(coldRead.status).toBe(409);
    const wrongHome = await request(`/workspace/hostile/opencode2/api/session/${chat.data.id}/message`);
    expect(wrongHome.status).toBe(404);
    await expect(access(imported)).rejects.toThrow();
    // Saving a restriction never admits new host work through the old process.
    const denied = await request(`/workspace/safe/opencode2/api/session/${sessionId}/shell`, "POST", { command: "printf forbidden" });
    expect(denied.status).toBe(409);
    const pendingPrompt = await request(`/workspace/safe/opencode2/api/session/${sessionId}/prompt`, "POST", { text: "Must not start in the old host process." });
    expect(pendingPrompt.status).toBe(409);
    // Existing inference may issue its next host tool after the saved denial.
    // It uses applied local policy, not desired intent, until this turn ends.
    holdInference = false; releaseInference();
    expect((await continuingChat).status).toBe(200);
    for (let attempt = 0; attempt < 200 && !await access(continuedHostTask).then(() => true, () => false); attempt++) await delay(25);
    expect(await readFile(continuedHostTask, "utf8").catch(async () => JSON.stringify({ offered, settings: await (await request("/workspace/safe/sandbox-settings")).json(), messages: await (await request(`/workspace/safe/opencode2/api/session/${chat.data.id}/message`)).json() }))).toBe("active turn completed its next host tool");
    await task;
    for (let attempt = 0; attempt < 200 && !await access(survived).then(() => true, () => false); attempt++) await delay(25);
    expect(await readFile(survived, "utf8")).toBe("survived");
    // No second save or admission request is needed to apply a durable choice.
    let automaticallyApplied = false;
    for (let attempt = 0; attempt < 200 && !automaticallyApplied; attempt++) {
      const settings: unknown = await (await request("/workspace/safe/sandbox-settings")).json();
      automaticallyApplied = record(settings) && settings.pending === false && settings.effectiveAllowHostExecution === false;
      if (!automaticallyApplied) await delay(25);
    }
    expect(automaticallyApplied).toBe(true);
    expect(await pid()).not.toBe(originalPid);
    // The hostile location was not initialized in the old project-enabled process.
    const setting = await request("/workspace/hostile/sandbox-settings", "PUT", { allowHostExecution: false });
    expect(setting.status, await setting.clone().text()).toBe(200);
    expect(await setting.json()).toEqual({ allowHostExecution: false, effectiveAllowHostExecution: false, pending: false, managed: false, featureEnabled: true });
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
    // A normal chat stays alive while the reverse transition is saved too.
    holdInference = true;
    offered.length = 0;
    const currentChat = request(`/workspace/hostile/opencode2/api/session/${next.data.id}/prompt`, "POST", { text: "Say transition complete again." });
    for (let attempt = 0; attempt < 200 && offered.length === 0; attempt++) await delay(25);
    expect(offered.length).toBeGreaterThan(0);
    const restore = await request("/workspace/hostile/sandbox-settings", "PUT", { allowHostExecution: true });
    expect(restore.status, await restore.clone().text()).toBe(200);
    expect(await restore.json()).toMatchObject({ allowHostExecution: true, effectiveAllowHostExecution: false, pending: true });
    expect(await pid()).toBe(isolatedPid);
    // Stop is an explicit person action and remains available during pending.
    // The earlier ordinary turn already proved there is no automatic abort.
    const stop = await request(`/workspace/hostile/opencode2/api/session/${next.data.id}/interrupt`, "POST", {});
    expect(stop.status, await stop.clone().text()).toBe(200);
    expect(await stop.json()).toMatchObject({ interrupted: true });
    releaseInference(); holdInference = false;
    expect((await currentChat).status).toBe(200);
    let restored = false;
    for (let attempt = 0; attempt < 200 && !restored; attempt++) {
      const settings: unknown = await (await request("/workspace/hostile/sandbox-settings")).json();
      restored = record(settings) && settings.pending === false && settings.effectiveAllowHostExecution === true;
      if (!restored) await delay(25);
    }
    expect(restored).toBe(true);
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
    releaseInference();
    await server.stop(); await fixture.stop();
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
