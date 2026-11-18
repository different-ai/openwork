import { expect, test } from "vitest";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFakeProvider } from "../../../packages/sandbox/src/testing/fake-provider.js";
import type { ServerConfig } from "../src/types.js";
import { createLocalSandboxRuntime } from "../src/local-sandbox-runtime.js";
import { managedDesktopPolicy } from "../src/managed-desktop-policy.js";
import { applySandboxSettings, readAppliedSandboxSettings, readSandboxSettings, writeSandboxSettings } from "../src/sandbox-settings-store.js";
import { sandboxHostRequest, sandboxPromptHasHostFiles } from "../src/sandbox-host-guards.js";
import { serve } from "../src/serve-node.js";
import { setupSandboxTools, type SandboxPluginContext, type SandboxToolMode, type HostNativeTool, type SandboxInferenceEvent } from "../src/opencode-plugins/openwork-sandbox-v2.js";
import { SANDBOX_TOOL_NAMES } from "../src/sandbox-tool-host.js";

async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), "sandbox-only-"));
  const workspace = join(temp, "project");
  await mkdir(workspace);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "sandbox-fixture-client", hostToken: "sandbox-fixture-host", configPath: join(temp, "state", "server.json"),
    trustedDenOrigin: "http://127.0.0.1:1", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "ws_sandbox", path: workspace, name: "Sandbox fixture", workspaceType: "local", preset: "starter" }],
    authorizedRoots: [temp], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  return { config, workspace, temp, cleanup: () => rm(temp, { force: true, recursive: true }) };
}

test("mode truth table: a required sandbox never becomes off or additive when disabled/down", async () => {
  const f = await fixture();
  try {
    for (const enabled of [false, true]) for (const localAllow of [false, true]) for (const hostDenied of [false, true]) {
      let factories = 0;
      const runtime = createLocalSandboxRuntime(f.config, {
        access: async () => ({ enabled, hostDenied, scope: "fixture" }), allowHostExecution: async () => localAllow,
        externalDirectories: async () => ({}), provider: async () => { factories++; throw new Error("runtime unavailable"); },
      });
      try {
        const required = !localAllow || hostDenied;
        expect(await runtime.status(f.workspace)).toEqual({ mode: required ? "only" : enabled ? "tools" : "off" });
        await expect(runtime.execute(f.workspace, "shell", { command: "touch /host-sentinel" })).rejects.toThrow(enabled ? "runtime unavailable" : "disabled");
        expect(factories).toBe(enabled ? 1 : 0);
        expect(await runtime.status(f.workspace)).toEqual({ mode: required ? "only" : enabled ? "tools" : "off" });
      } finally { await runtime.close(); }
    }
  } finally { await f.cleanup(); }
});

test("local preference is engine-global DB state; a workspace JSON cannot import or loosen it", async () => {
  const f = await fixture();
  try {
    expect(await readSandboxSettings(f.config)).toEqual({ allowHostExecution: true });
    await writeFile(join(f.workspace, "openwork.json"), JSON.stringify({ allowHostExecution: false }));
    expect(await readSandboxSettings(f.config)).toEqual({ allowHostExecution: true });
    await writeSandboxSettings(f.config, { allowHostExecution: false });
    await writeFile(join(f.workspace, "openwork.json"), JSON.stringify({ allowHostExecution: true }));
    expect(await readSandboxSettings({ ...f.config })).toEqual({ allowHostExecution: false });
    expect(JSON.parse(await readFile(join(f.workspace, "openwork.json"), "utf8"))).toEqual({ allowHostExecution: true });
    await expect(managedDesktopPolicy(f.config).assertHostExecution()).rejects.toThrow("Host execution is disabled");
  } finally { await f.cleanup(); }
});

test("desired intent is durable without changing the applied local policy of active work", async () => {
  const f = await fixture();
  const policy = managedDesktopPolicy(f.config);
  const runtime = createLocalSandboxRuntime(f.config, { access: async () => ({ enabled: true, scope: "fixture" }) });
  try {
    await applySandboxSettings(f.config);
    await writeSandboxSettings(f.config, { allowHostExecution: false });
    expect(await readSandboxSettings({ ...f.config })).toEqual({ allowHostExecution: false });
    expect(await readAppliedSandboxSettings({ ...f.config })).toEqual({ allowHostExecution: true });
    expect(await policy.requiresSandbox()).toBe(true);
    await expect(policy.assertHostExecution()).resolves.toBeUndefined();
    expect(await runtime.status(f.workspace)).toEqual({ mode: "tools" });
    await expect(policy.assertLegacyExecutionRequest(new Request("http://localhost/opencode/session", { method: "POST" }), "/opencode/session")).rejects.toMatchObject({ code: "sandbox_only" });
    await applySandboxSettings(f.config);
    await expect(policy.assertHostExecution()).rejects.toMatchObject({ code: "sandbox_only" });
    expect(await runtime.status(f.workspace)).toEqual({ mode: "only" });
    await writeSandboxSettings(f.config, { allowHostExecution: true });
    expect(await readAppliedSandboxSettings(f.config)).toEqual({ allowHostExecution: false });
    await expect(policy.assertHostExecution()).rejects.toMatchObject({ code: "sandbox_only" });
    await applySandboxSettings(f.config);
    await expect(policy.assertHostExecution()).resolves.toBeUndefined();
  } finally { await runtime.close(); await f.cleanup(); }
});

test("verified org deny beats local allow, survives flag off/outage and scoped cold restart", async () => {
  const f = await fixture();
  let enabled = true;
  let deny = true;
  let unavailable = false;
  const headers: (string | null)[] = [];
  const den = await serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    if (unavailable) return new Response(null, { status: 503 });
    if (new URL(request.url).pathname === "/v1/org") return Response.json({ features: { sandboxTools: enabled } });
    headers.push(request.headers.get("x-openwork-sandbox-only"));
    return Response.json({ agentPermissions: { rules: [{ action: "host_execution", resource: "*", effect: deny ? "deny" : "allow", source: "Everyone" }] } });
  } });
  const session = { baseUrl: `http://127.0.0.1:${den.port}`, orgId: "org_fixture", token: "fixture-token" };
  try {
    const policy = managedDesktopPolicy(f.config);
    await policy.setSession(session);
    await policy.current();
    expect(await policy.sandboxSettings()).toEqual({ allowHostExecution: true, effectiveAllowHostExecution: false, managed: true, managedMode: "sandbox", deviceRestricted: false, featureEnabled: true });
    expect(headers.every(header => header === "1")).toBe(true);
    await expect(policy.assertHostExecution()).rejects.toThrow("requires sandbox-only");
    expect((await policy.computerRules()).map(rule => rule.effect)).toEqual(["deny", "deny", "deny", "deny"]);
    enabled = false;
    expect(await policy.sandboxSettings()).toMatchObject({ effectiveAllowHostExecution: false, managed: true, featureEnabled: false });
    unavailable = true;
    const restarted = managedDesktopPolicy({ ...f.config });
    await restarted.setSession({ ...session, token: "rotated-fixture-token" });
    expect(await restarted.sandboxSettings()).toMatchObject({ effectiveAllowHostExecution: false, managed: true, featureEnabled: false });
    unavailable = false;
    deny = false;
    expect(await policy.sandboxSettings()).toMatchObject({ effectiveAllowHostExecution: true, managed: true, managedMode: "computer", deviceRestricted: false, featureEnabled: false });
    await writeSandboxSettings(f.config, { allowHostExecution: false });
    expect(await policy.sandboxSettings()).toMatchObject({ allowHostExecution: false, effectiveAllowHostExecution: false, managed: true, managedMode: "computer", deviceRestricted: true });
  } finally { await den.stop(); await f.cleanup(); }
});

test("managed computer and sandbox choices are distinct from unconfigured Allow and never overwrite a stricter device choice", async () => {
  const f = await fixture();
  let decision: "allow" | "deny" | undefined;
  const den = await serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    if (new URL(request.url).pathname === "/v1/org") return Response.json({ features: { sandboxTools: true } });
    return Response.json({ agentPermissions: { rules: decision ? [{ action: "host_execution", resource: "*", effect: decision, source: "Everyone" }] : [] } });
  } });
  const policy = managedDesktopPolicy(f.config);
  try {
    await policy.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, orgId: "org_location", token: "location-fixture-token" });
    await policy.current();
    expect(await policy.sandboxSettings()).toMatchObject({ managed: false, managedMode: null, effectiveAllowHostExecution: true });
    decision = "allow";
    expect(await policy.sandboxSettings()).toMatchObject({ managed: true, managedMode: "computer", effectiveAllowHostExecution: true, deviceRestricted: false });
    await writeSandboxSettings(f.config, { allowHostExecution: false });
    await applySandboxSettings(f.config);
    expect(await policy.sandboxSettings()).toMatchObject({ managed: true, managedMode: "computer", effectiveAllowHostExecution: false, deviceRestricted: true });
    await expect(policy.assertHostExecution()).rejects.toMatchObject({ code: "sandbox_only" });
    expect(await readSandboxSettings(f.config)).toEqual({ allowHostExecution: false });
    decision = "deny";
    expect(await policy.sandboxSettings()).toMatchObject({ managed: true, managedMode: "sandbox", effectiveAllowHostExecution: false, deviceRestricted: false });
    decision = undefined;
    expect(await policy.sandboxSettings()).toMatchObject({ managed: false, managedMode: null, effectiveAllowHostExecution: false });
    expect(await readSandboxSettings(f.config)).toEqual({ allowHostExecution: false });
  } finally { await policy.clearSession(); await den.stop(); await f.cleanup(); }
});

test("a first unverified sign-in never grants host execution, even with local allow and no cached org deny", async () => {
  const f = await fixture();
  let unavailable = true;
  let required = true;
  const den = await serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    if (unavailable) return new Response(null, { status: 503 });
    if (new URL(request.url).pathname === "/v1/org") return Response.json({ features: { sandboxTools: false } });
    return Response.json({ agentPermissions: { rules: [{ action: "host_execution", resource: "*", effect: required ? "deny" : "allow", source: "Everyone" }] } });
  } });
  const session = { baseUrl: `http://127.0.0.1:${den.port}`, orgId: "org_first_read", token: "first-fixture-token" };
  const policy = managedDesktopPolicy(f.config);
  const runtime = createLocalSandboxRuntime(f.config);
  try {
    // Signed-out ordinary mode is unchanged, including when rollout cannot be read.
    await expect(policy.assertHostExecution()).resolves.toBeUndefined();
    await policy.setSession(session);
    await policy.current();
    expect(await policy.sandboxSettings()).toEqual({ allowHostExecution: true, effectiveAllowHostExecution: false, managed: false, managedMode: null, deviceRestricted: false, featureEnabled: false });
    await expect(policy.assertHostExecution()).rejects.toThrow("not yet been verified for this sign-in");
    expect(await runtime.status(f.workspace)).toEqual({ mode: "only" });
    unavailable = false;
    expect(await policy.sandboxSettings()).toMatchObject({ effectiveAllowHostExecution: false, managed: true, featureEnabled: false });
    await expect(policy.assertHostExecution()).rejects.toThrow("requires sandbox-only");
    required = false;
    expect(await policy.sandboxSettings()).toMatchObject({ effectiveAllowHostExecution: true, managed: true, managedMode: "computer", deviceRestricted: false, featureEnabled: false });
    // Previously verified Allow can keep its ordinary offline behaviour for
    // this identity; a changed identity must verify again, never inherit it.
    unavailable = true;
    await expect(policy.assertHostExecution()).resolves.toBeUndefined();
    await policy.setSession({ ...session, token: "different-sign-in-fixture-token" });
    await expect(policy.assertHostExecution()).rejects.toThrow("not yet been verified for this sign-in");
    expect(await runtime.status(f.workspace)).toEqual({ mode: "only" });
  } finally { await runtime.close(); await policy.clearSession(); await den.stop(); await f.cleanup(); }
});

test("signed-out rollout reads only the trusted configured Den /v1/features without credentials", async () => {
  const f = await fixture();
  let enabled = true;
  const calls: { path: string; authorization: string | null }[] = [];
  const den = await serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    calls.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") });
    return Response.json({ version: 1, features: { sandboxTools: enabled } });
  } });
  f.config.trustedDenOrigin = `http://127.0.0.1:${den.port}`;
  try {
    const policy = managedDesktopPolicy(f.config);
    expect(await policy.sandboxSettings()).toEqual({ allowHostExecution: true, effectiveAllowHostExecution: true, managed: false, managedMode: null, deviceRestricted: false, featureEnabled: true });
    enabled = false;
    await writeSandboxSettings(f.config, { allowHostExecution: false });
    expect(await policy.sandboxSettings()).toEqual({ allowHostExecution: false, effectiveAllowHostExecution: false, managed: false, managedMode: null, deviceRestricted: false, featureEnabled: false });
    expect(calls).toEqual([{ path: "/v1/features", authorization: null }, { path: "/v1/features", authorization: null }]);
    f.config.trustedDenOrigin = `${f.config.trustedDenOrigin}/untrusted-path`;
    expect((await policy.localSandboxAccess()).enabled).toBe(false);
    expect(calls).toHaveLength(2);
  } finally { await den.stop(); await f.cleanup(); }
});

test("required catalog is bounded, before-call guards reject stale custom tools, and MCP is disabled before spawn", async () => {
  let mode: SandboxToolMode = "only";
  let before: ((event: { tool: string }) => Promise<void>) | undefined;
  let prompt: (() => Promise<void>) | undefined;
  const inference = new Map<string, (event: SandboxInferenceEvent) => Promise<void>>();
  const originals = new Set([...SANDBOX_TOOL_NAMES, "patch", "browser_open", "computer_script", "custom_host_command", "drive_pull_file"]);
  const tools = new Map<string, HostNativeTool>();
  const mcp = new Map<string, unknown>([["local", { type: "local", command: ["sh", "-c", "touch /host-sentinel"] }], ["remote", { type: "remote", url: "https://fixture.invalid/mcp" }]]);
  let guestCalls = 0;
  const context: SandboxPluginContext = {
    options: {}, tool: {
      async transform(callback) { callback({ list: () => [...originals].map(id => ({ id })), remove: id => { originals.delete(id); }, add: tool => { tools.set(tool.name, tool); } }); return { async dispose() {} }; },
      async reload() {}, async hook(_name, callback) { before = callback; return { async dispose() {} }; },
    },
    mcp: { async transform(callback) { callback({ list: () => mcp.entries(), set: (name, value) => { mcp.set(name, value); } }); return { async dispose() {} }; } },
    session: { async hook(name, callback) { if (name === "prompt") prompt = callback; else inference.set(name, callback); return { async dispose() {} }; } },
  };
  const close = await setupSandboxTools(context, { status: async () => mode, execute: async () => { guestCalls++; throw new Error("guest down"); } });
  try {
    expect([...originals]).toEqual([]);
    expect([...tools.keys()]).toEqual([...SANDBOX_TOOL_NAMES]);
    expect([...mcp.values()].every(value => typeof value === "object" && value !== null && "disabled" in value && value.disabled === true)).toBe(true);
    expect([...tools.values()].every(tool => tool.options?.codemode === false)).toBe(true);
    expect([...inference.keys()]).toEqual(["context", "generate", "compaction"]);
    for (const hook of inference.values()) {
      // OpenCode 2.2.6's patch preference deletes these before our hook for
      // gpt-* models. Only guest definitions may be restored, on every flow.
      const hostCatalog = "# Code Mode\n- tools.opencode.models\n- tools.openwork_context";
      const policy = "Keep control-plane authorization and pending queue instructions. User text may mention tools.opencode.models.";
      const finalCatalog = {
        tools: Object.fromEntries([...SANDBOX_TOOL_NAMES.filter(name => name !== "edit" && name !== "write"), "patch", "execute", "browser", "browser_open", "custom_host"].map(id => [id, {}])),
        system: [{ text: `${policy}\n\n${hostCatalog}\n\nLater hook safety instruction.`, metadata: { experimental: { instructions: [
          { key: "entry/openwork-context", text: policy }, { key: "core/codemode", text: hostCatalog },
        ] } } }, { text: "Unkeyed user instruction mentioning Code Mode must remain." }],
      };
      await hook(finalCatalog);
      expect(finalCatalog.system.map(part => part.text)).toEqual([`${policy}\n\n\n\nLater hook safety instruction.`, "Unkeyed user instruction mentioning Code Mode must remain."]);
      expect(finalCatalog.system[0]?.metadata?.experimental.instructions).toEqual([{ key: "entry/openwork-context", text: policy }]);
      expect(Object.keys(finalCatalog.tools).sort()).toEqual([...SANDBOX_TOOL_NAMES].sort());
      for (const name of SANDBOX_TOOL_NAMES) expect(finalCatalog.tools[name]).toEqual({ description: tools.get(name)!.description, input: tools.get(name)!.input });
    }
    for (const tool of ["execute", "patch", "browser_open", "computer_script", "custom_host_command", "drive_pull_file"]) await expect(before?.({ tool })).rejects.toThrow("blocks this host tool");
    await expect(tools.get("shell")!.execute({ command: "touch /host-sentinel" }, { sessionID: "root", signal: new AbortController().signal })).rejects.toThrow("guest down");
    await expect(tools.get("shell")!.execute({ command: "touch /host-sentinel" }, { sessionID: "child", signal: new AbortController().signal })).rejects.toThrow("guest down");
    expect(guestCalls).toBe(2);
    for (const ordinaryMode of ["tools", "off"] satisfies SandboxToolMode[]) {
      mode = ordinaryMode;
      for (const hook of inference.values()) {
        const ordinary = { tools: { execute: {} }, system: [{ text: "Host catalog", metadata: { experimental: { instructions: [{ key: "core/codemode", text: "Host catalog" }] } } }] };
        await hook(ordinary);
        expect(ordinary.tools).toEqual({ execute: {} });
        expect(ordinary.system[0]?.text).toBe("Host catalog");
      }
    }
    await expect(prompt?.()).rejects.toThrow("Restart the engine");
    expect([...originals]).toEqual([]);
  } finally { await close(); }
});

test("a retained host primitive snapshot cannot execute after sandbox-only revocation", async () => {
  let mode: SandboxToolMode = "tools";
  let hostRuns = 0;
  let retained: HostNativeTool | undefined;
  let prompt: (() => Promise<void>) | undefined;
  const original = { id: "shell", name: "shell", description: "host", input: {}, options: { codemode: false }, execute: async () => { hostRuns++; return { content: [] }; } };
  const context: SandboxPluginContext = {
    options: {}, tool: {
      async transform(callback) { callback({ list: () => [original], remove() {}, add(tool) { if (tool.name === "shell") retained = tool; } }); return { async dispose() {} }; },
      async hook() { return { async dispose() {} }; }, async reload() {},
    },
    mcp: { async transform() { return { async dispose() {} }; }, async reload() {} },
    session: { async hook(name, callback) { if (name === "prompt") prompt = callback; return { async dispose() {} }; } },
  };
  const close = await setupSandboxTools(context, { status: async () => mode, execute: async () => ({ content: [] }) });
  try {
    const call = { sessionID: "old-session", signal: new AbortController().signal };
    await retained?.execute({ command: "allowed" }, call);
    expect(hostRuns).toBe(1);
    mode = "only";
    await prompt?.();
    await expect(retained?.execute({ command: "must not run" }, call)).rejects.toThrow("revoked this host tool snapshot");
    expect(hostRuns).toBe(1);
  } finally { await close(); }
});

test("initial bridge failure and missing guard primitives reject admission, never fall back to host catalog", async () => {
  const context: SandboxPluginContext = { options: {}, tool: { async transform() { throw new Error("must not expose tools"); }, async reload() {} }, session: { async hook() { throw new Error("must not admit prompt"); } } };
  await expect(setupSandboxTools(context, { status: async () => { throw new Error("bridge unavailable"); }, execute: async () => ({ content: [] }) })).rejects.toThrow("enforcement is unavailable");
  await expect(setupSandboxTools(context, { status: async () => "only", execute: async () => ({ content: [] }) })).rejects.toThrow("enforcement is unavailable");
});

test("host API guard covers files, alternate execution, MCP transports, but not native inference or stop", async () => {
  for (const path of ["/workspace/ws/files/raw", "/workspace/ws/inbox", "/workspace/ws/artifacts/resolve", "/files/sessions/id/ops", "/cloud-computer/frame", "/workspace/ws/mcp-apps/call", "/mcp/managed/ws/local"]) expect(sandboxHostRequest("GET", path, false)).toBe(true);
  for (const path of ["/api/session/s/shell", "/api/session/s/command", "/api/pty", "/api/experimental/mcp/local", "/api/rpc/custom/run", "/api/config"]) expect(sandboxHostRequest("POST", path, true)).toBe(true);
  for (const path of ["/api/session", "/api/session/s/prompt", "/api/session/s/model", "/api/session/s/abort"]) expect(sandboxHostRequest("POST", path, true)).toBe(false);
  const contextPath = "/workspace/ws/opencode2/api/experimental/session/s/instructions/entries/openwork-context";
  expect(sandboxHostRequest("PUT", contextPath, true)).toBe(false);
  expect(sandboxHostRequest("POST", contextPath, true)).toBe(true);
  expect(sandboxHostRequest("PUT", contextPath.replace("openwork-context", "arbitrary-entry"), true)).toBe(true);
  expect(sandboxHostRequest("PUT", `${contextPath}/execute`, true)).toBe(true);
  expect(sandboxPromptHasHostFiles({ parts: [{ type: "file", url: "file:///host/secret" }] })).toBe(true);
  expect(sandboxPromptHasHostFiles({ text: "read file:///host/secret with the guest read tool" })).toBe(false);
  const f = await fixture();
  try {
    const policy = managedDesktopPolicy(f.config);
    // Flag off/default preference: ordinary host surfaces retain their behaviour.
    await expect(policy.assertRequest(new Request("http://localhost/workspace/ws/files/raw"), "/workspace/ws/files/raw")).resolves.toBeUndefined();
    await writeSandboxSettings(f.config, { allowHostExecution: false });
    await expect(policy.assertRequest(new Request("http://localhost/workspace/ws/files/raw"), "/workspace/ws/files/raw")).rejects.toThrow("Host execution is disabled");
    await expect(policy.assertLegacyExecutionRequest(new Request("http://localhost/session"), "/session")).rejects.toThrow("Host execution is disabled");
    const contextRequest = (body: unknown) => new Request(`http://localhost${contextPath}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await expect(policy.assertRequest(contextRequest({ value: "Use the six guest primitives." }), contextPath, true)).resolves.toBeUndefined();
    await expect(policy.assertRequest(contextRequest({ parts: [{ type: "file", url: "file:///host/secret" }] }), contextPath, true)).rejects.toThrow("Host execution is disabled");
  } finally { await f.cleanup(); }
});

test("browser, computer and file-transfer bridges deny host dispatch for root and child sessions", async () => {
  const f = await fixture();
  await writeSandboxSettings(f.config, { allowHostExecution: false });
  const { createV2ContextBridge } = await import("../src/opencode-v2-context-bridge.js");
  let hostCalls = 0;
  const bridge = await createV2ContextBridge(async () => { hostCalls++; return {}; }, undefined, undefined, undefined, f.config);
  const call = async (url: string, token: string, body: unknown) => {
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Host execution is disabled");
  };
  try {
    const initialHostCalls = hostCalls;
    for (const sessionId of ["root", "child"]) {
      await call(bridge.browser.url, bridge.browser.token, { name: "browser_open", input: { url: "https://must-not-open.invalid" }, sessionId, ...(sessionId === "child" ? { rootSessionId: "root" } : {}) });
      await call(bridge.browser.url, bridge.browser.token, { name: "computer_open", input: { app_id: "must-not-open" }, sessionId });
      for (const name of ["openwork_drive_upload", "openwork_gmail_draft", "openwork_outlook_draft", "drive_pull_file", "drive_push_file", "drive_file_status"]) {
        await call(bridge.url, bridge.token, { name, input: {}, sessionId });
      }
    }
    expect(hostCalls).toBe(initialHostCalls);
  } finally { await bridge.close(); await f.cleanup(); }
});

test("required runtime preserves absolute native mounts and read-only grants", async () => {
  const f = await fixture();
  const provider = createFakeProvider({ id: "microsandbox" });
  const mounts: unknown[] = [];
  f.config.readOnly = true;
  const runtime = createLocalSandboxRuntime(f.config, {
    access: async () => ({ enabled: true, scope: "fixture", hostDenied: true }), allowHostExecution: async () => false,
    externalDirectories: async () => ({}), provider: async input => { mounts.push(...input); return provider; },
  });
  try {
    await runtime.execute(f.workspace, "shell", { command: "true" });
    expect(mounts).toEqual([{ hostPath: await realpath(f.workspace), guestPath: f.workspace, access: "ro" }]);
  } finally { await runtime.close(); await f.cleanup(); }
});

test("server admission refuses a missing sandbox runtime while ordinary flag-off requests stay unchanged", async () => {
  const f = await fixture();
  const { createEngineV2Preview } = await import("../src/engine-v2-preview.js");
  const { EnvService } = await import("../src/env-file.js");
  const engine = createEngineV2Preview({ config: f.config, env: new EnvService(), deferStart: true });
  try {
    await expect(engine.assertSandboxReady(f.workspace)).resolves.toBeUndefined();
    await writeSandboxSettings(f.config, { allowHostExecution: false });
    await expect(engine.assertSandboxReady(f.workspace)).rejects.toThrow("No task was admitted");
  } finally { await engine.stop(); await f.cleanup(); }
});

test("cold trusted metadata and legacy reload/routing cannot initialize a v1 project in required mode", async () => {
  const f = await fixture();
  const marker = join(f.temp, "legacy-module-or-mcp-started");
  await mkdir(join(f.workspace, ".opencode", "plugins"), { recursive: true });
  await writeFile(join(f.workspace, ".opencode", "plugins", "unsafe.ts"), "export default { id: 'unsafe-fixture', setup() {} };\n");
  let legacyRequests = 0;
  const legacy = await serve({ hostname: "127.0.0.1", port: 0, fetch: async () => { legacyRequests++; await writeFile(marker, "legacy location initialized"); return Response.json({}); } });
  f.config.externalOpencode = true;
  f.config.engineAutoUpgrade = false;
  f.config.workspaces[0]!.baseUrl = `http://127.0.0.1:${legacy.port}`;
  const previewOverride = process.env.OPENWORK_ENGINE_V2_PREVIEW;
  process.env.OPENWORK_ENGINE_V2_PREVIEW = "0";
  await writeSandboxSettings(f.config, { allowHostExecution: false });
  const { startServer } = await import("../src/server.js");
  const { createEngineV2Preview } = await import("../src/engine-v2-preview.js");
  const preview = createEngineV2Preview({ config: f.config, deferStart: true });
  const server = await startServer(f.config, { deferManagedEngineStartup: true });
  const root = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: `Bearer ${f.config.token}`, "content-type": "application/json" };
  const before = await readdir(f.workspace);
  try {
    for (const path of ["authorized-folders", "config"]) expect((await fetch(`${root}/workspace/ws_sandbox/${path}`, { headers })).status).toBe(200);
    expect((await fetch(`${root}/workspace/ws_sandbox/permissions/effective`, { headers })).status).toBe(403);
    expect((await fetch(`${root}/workspace/ws_sandbox/engine/reload`, { method: "POST", headers, body: "{}" })).status).toBe(403);
    await expect(preview.setChatRouting(false)).rejects.toMatchObject({ status: 403, code: "sandbox_only" });
    await expect(preview.setEnabled(false)).rejects.toMatchObject({ status: 403, code: "sandbox_only" });
    await delay(50);
    expect(legacyRequests).toBe(0);
    await expect(access(marker)).rejects.toThrow();
    expect(await readdir(f.workspace)).toEqual(before);
  } finally {
    await preview.stop(); await server.stop(); await legacy.stop(); await f.cleanup();
    if (previewOverride === undefined) delete process.env.OPENWORK_ENGINE_V2_PREVIEW;
    else process.env.OPENWORK_ENGINE_V2_PREVIEW = previewOverride;
  }
});

test("settings route requires approval before engine-global writes and leaves workspace files alone", async () => {
  const f = await fixture();
  f.config.approval = { mode: "manual", timeoutMs: 10_000 };
  f.config.engineAutoUpgrade = false;
  const previewOverride = process.env.OPENWORK_ENGINE_V2_PREVIEW;
  process.env.OPENWORK_ENGINE_V2_PREVIEW = "0";
  const { startServer } = await import("../src/server.js");
  const server = await startServer(f.config, { deferManagedEngineStartup: true });
  const root = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: `Bearer ${f.config.token}`, "content-type": "application/json" };
  const hostHeaders = { "x-openwork-host-token": f.config.hostToken, "content-type": "application/json" };
  try {
    const route = `${root}/workspace/ws_sandbox/sandbox-settings`;
    expect(await (await fetch(route, { headers })).json()).toEqual({ allowHostExecution: true, effectiveAllowHostExecution: true, pending: false, managed: false, managedMode: null, deviceRestricted: false, featureEnabled: false, folderAccess: "read-write", runtime: null });
    const pending = fetch(route, { method: "PUT", headers, body: JSON.stringify({ allowHostExecution: false }) });
    let approvalId: string | undefined;
    for (let attempt = 0; attempt < 50 && !approvalId; attempt++) {
      const approvals = await (await fetch(`${root}/approvals`, { headers: hostHeaders })).json();
      approvalId = approvals.items?.find((item: { action: string }) => item.action === "config.sandbox_settings.write")?.id;
      if (!approvalId) await delay(10);
    }
    expect(approvalId).toBeTruthy();
    expect(await readSandboxSettings(f.config)).toEqual({ allowHostExecution: true });
    await fetch(`${root}/approvals/${approvalId}`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ reply: "allow" }) });
    const updated = await pending;
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ allowHostExecution: false, effectiveAllowHostExecution: false, pending: false, managed: false, managedMode: null, deviceRestricted: false, featureEnabled: false, folderAccess: "read-write", runtime: null });
    expect(await readSandboxSettings(f.config)).toEqual({ allowHostExecution: false });
    expect((await fetch(`${root}/workspace/ws_sandbox/files/raw?path=missing.txt`, { headers })).status).toBe(403);
    expect((await fetch(route, { method: "PUT", headers, body: JSON.stringify({ allowHostExecution: "yes" }) })).status).toBe(400);
  } finally {
    await server.stop(); await f.cleanup();
    if (previewOverride === undefined) delete process.env.OPENWORK_ENGINE_V2_PREVIEW;
    else process.env.OPENWORK_ENGINE_V2_PREVIEW = previewOverride;
  }
});
