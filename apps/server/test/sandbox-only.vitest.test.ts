import { expect, test, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFakeProvider } from "../../../packages/sandbox/src/testing/fake-provider.js";
import type { ServerConfig } from "../src/types.js";
import { createLocalSandboxRuntime } from "../src/local-sandbox-runtime.js";
import { managedDesktopPolicy } from "../src/managed-desktop-policy.js";
import { applySandboxSettings, readAppliedSandboxSettings, readSandboxSettings, updateSandboxSettings, writeSandboxSettings } from "../src/sandbox-settings-store.js";
import { sandboxHostRequest, sandboxPromptHasHostFiles } from "../src/sandbox-host-guards.js";
import { serve } from "../src/serve-node.js";
import { openRuntimeSqliteDatabase, runtimeDbPath } from "../src/runtime-db.js";
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
    for (const enabled of [false, true]) for (const local of ["off", "use", "force"]) for (const org of ["off", "use", "force", "unverified"]) {
      let factories = 0;
      const runtime = createLocalSandboxRuntime(f.config, {
        access: async () => ({ enabled, hostDenied: org === "force", hostPolicyVerified: org !== "unverified", useRequired: org === "use", scope: "fixture" }),
        settings: async () => ({ useSandbox: local !== "off", forceSandbox: local === "force" }),
        externalDirectories: async () => ({}), provider: async () => { factories++; throw new Error("runtime unavailable"); },
      });
      try {
        const required = local === "force" || org === "force" || org === "unverified";
        expect(await runtime.status(f.workspace)).toEqual({ mode: required ? "only" : enabled && (local === "use" || org === "use") ? "tools" : "off" });
        await expect(runtime.execute(f.workspace, "shell", { command: "true" })).rejects.toThrow(/Nothing ran/);
        // Even a previously offered call cannot acquire a provider when the rollout is off.
        expect(factories).toBe(enabled ? 1 : 0);
        expect(await runtime.status(f.workspace)).toEqual({ mode: required ? "only" : enabled && (local === "use" || org === "use") ? "tools" : "off" });
      } finally { await runtime.close(); }
    }
  } finally { await f.cleanup(); }
});

test("a worktree outside registered projects offers ordinary tools unless Force applies", async () => {
  const f = await fixture();
  const outside = join(f.temp, "worktree");
  const policy = managedDesktopPolicy(f.config);
  const runtime = createLocalSandboxRuntime(f.config, { access: async () => ({ enabled: true, scope: "fixture" }) });
  try {
    await writeSandboxSettings(f.config, { useSandbox: true, forceSandbox: false });
    expect(await runtime.status(outside)).toEqual({ mode: "off" });
    const ordinary = await setupSandboxTools({
      options: {},
      tool: { async transform(edit) {
        const original = { id: "shell", name: "shell", description: "test fixture", input: {}, async execute() { return "normal tool ran"; } };
        let wrapped: HostNativeTool | undefined;
        edit({ list: () => [original], remove() {}, add(tool) { wrapped = tool; } });
        expect(await wrapped?.execute({}, { sessionID: "worktree", signal: AbortSignal.timeout(1_000) })).toBe("normal tool ran");
        return { async dispose() {} };
      }, async reload() {} },
      session: { async hook() { return { async dispose() {} }; } },
    }, {
      async status() { return (await runtime.status(outside)).mode; },
      assertHostExecution: () => policy.assertHostExecution(),
      execute: (name, input, call) => runtime.execute(outside, name, input, call),
    });
    await ordinary();
    await writeSandboxSettings(f.config, { useSandbox: true, forceSandbox: true });
    await applySandboxSettings(f.config);
    expect(await runtime.status(outside)).toEqual({ mode: "only" });
    await expect(policy.assertHostExecution()).rejects.toMatchObject({ code: "sandbox_only" });
    await expect(runtime.execute(outside, "shell", { command: "true" })).rejects.toThrow("The sandbox can only be used in a project folder opened in OpenWork. Nothing ran on this computer.");
  } finally { await runtime.close(); await f.cleanup(); }
});

test("local preference is engine-global DB state; a workspace JSON cannot import or loosen it", async () => {
  const f = await fixture();
  try {
    expect(await readSandboxSettings(f.config)).toEqual({ useSandbox: false, forceSandbox: false });
    await writeFile(join(f.workspace, "openwork.json"), JSON.stringify({ allowHostExecution: false }));
    expect(await readSandboxSettings(f.config)).toEqual({ useSandbox: false, forceSandbox: false });
    await writeSandboxSettings(f.config, { useSandbox: true, forceSandbox: true });
    await writeFile(join(f.workspace, "openwork.json"), JSON.stringify({ allowHostExecution: true }));
    expect(await readSandboxSettings({ ...f.config })).toEqual({ useSandbox: true, forceSandbox: true });
    expect(JSON.parse(await readFile(join(f.workspace, "openwork.json"), "utf8"))).toEqual({ allowHostExecution: true });
    await expect(managedDesktopPolicy(f.config).assertHostExecution()).rejects.toThrow("This action can only run in the sandbox");
  } finally { await f.cleanup(); }
});

test("legacy desired and applied rows migrate independently, and corrupt rows fail closed", async () => {
  const f = await fixture();
  try {
    await writeSandboxSettings(f.config, { useSandbox: false, forceSandbox: false });
    await applySandboxSettings(f.config);
    const db = await openRuntimeSqliteDatabase(runtimeDbPath(f.config));
    try {
      db.sqlite.prepare("UPDATE runtime_sandbox_settings SET settings_json = ?").run('{"allowHostExecution":false}');
      db.sqlite.prepare("UPDATE runtime_sandbox_applied_settings SET settings_json = ?").run('{"allowHostExecution":true}');
      expect(await readSandboxSettings(f.config)).toEqual({ useSandbox: true, forceSandbox: true });
      expect(await readAppliedSandboxSettings(f.config)).toEqual({ useSandbox: false, forceSandbox: false });
      db.sqlite.prepare("UPDATE runtime_sandbox_settings SET settings_json = ?").run('{"forceSandbox":false}');
      db.sqlite.prepare("UPDATE runtime_sandbox_applied_settings SET settings_json = ?").run('broken json');
      expect(await readSandboxSettings(f.config)).toEqual({ useSandbox: true, forceSandbox: true });
      expect(await readAppliedSandboxSettings(f.config)).toEqual({ useSandbox: true, forceSandbox: true });
      await writeSandboxSettings(f.config, { useSandbox: false, forceSandbox: true });
      const persisted = db.sqlite.prepare("SELECT settings_json FROM runtime_sandbox_settings").get();
      expect(persisted).toEqual({ settings_json: '{"useSandbox":true,"forceSandbox":true}' });
    } finally { db.sqlite.close(); }
  } finally { await f.cleanup(); }
});

test("a concurrent Use-only save cannot undo a Force save", async () => {
  const f = await fixture();
  try {
    await Promise.all([updateSandboxSettings(f.config, { forceSandbox: true }), updateSandboxSettings(f.config, { useSandbox: true })]);
    expect(await readSandboxSettings(f.config)).toEqual({ useSandbox: true, forceSandbox: true });
  } finally { await f.cleanup(); }
});

test("Den verification runs both reads in parallel, shares them, and expires without losing a restriction on failure", async () => {
  const f = await fixture();
  let desktopReads = 0;
  let orgReads = 0;
  let mode: "use" | "force" | "offline" = "use";
  const orgStarted = Promise.withResolvers<void>();
  const desktopStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const den = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const isOrg = new URL(request.url).pathname === "/v1/org";
    if (isOrg) { orgReads++; orgStarted.resolve(); }
    else { desktopReads++; desktopStarted.resolve(); }
    await release.promise;
    if (mode === "offline") return new Response(null, { status: 403 });
    if (isOrg) return Response.json({ features: { sandboxTools: true } });
    expect(request.headers.get("x-openwork-sandbox-only")).toBe("1");
    expect(request.headers.get("x-openwork-sandbox-modes")).toBe("1");
    return Response.json({ agentPermissions: { rules: [{ action: mode === "force" ? "host_execution" : "sandbox_opt_out", resource: "*", effect: "deny", source: "Everyone" }] } });
  } });
  const policy = managedDesktopPolicy(f.config);
  try {
    await policy.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, orgId: "org_concurrent", token: "member" });
    const parallel = Promise.all(Array.from({ length: 20 }, () => policy.localSandboxAccess()));
    const firstRound = await Promise.race([Promise.all([orgStarted.promise, desktopStarted.promise]).then(() => true), delay(400, false)]);
    expect(firstRound).toBe(true);
    release.resolve();
    for (const access of await parallel) expect(access).toMatchObject({ enabled: true, useRequired: true, hostDenied: false, hostPolicyVerified: true });
    for (let i = 0; i < 4; i++) {
      await expect(policy.assertHostExecution()).resolves.toBeUndefined();
      expect(await policy.sandboxSettings()).toMatchObject({ managedUse: true, managedForce: false, effectiveUseSandbox: true });
    }
    expect([desktopReads, orgReads]).toEqual([1, 1]);
    mode = "force";
    await delay(2_010);
    await expect(policy.assertHostExecution()).rejects.toMatchObject({ code: "sandbox_only" });
    expect([desktopReads, orgReads]).toEqual([2, 1]);
    mode = "offline";
    await writeSandboxSettings(f.config, { useSandbox: true, forceSandbox: false });
    expect(await policy.localSandboxAccess()).toMatchObject({ enabled: false, hostDenied: true, hostPolicyVerified: true });
    expect([desktopReads, orgReads]).toEqual([3, 2]);
    await expect(policy.assertHostExecution()).rejects.toMatchObject({ code: "sandbox_only" });
  } finally { release.resolve(); await den.stop(); await f.cleanup(); }
});

test("desired intent is durable without changing the applied local policy of active work", async () => {
  const f = await fixture();
  const policy = managedDesktopPolicy(f.config);
  const runtime = createLocalSandboxRuntime(f.config, { access: async () => ({ enabled: true, scope: "fixture" }) });
  try {
    await applySandboxSettings(f.config);
    await writeSandboxSettings(f.config, { useSandbox: true, forceSandbox: true });
    expect(await readSandboxSettings({ ...f.config })).toEqual({ useSandbox: true, forceSandbox: true });
    expect(await readAppliedSandboxSettings({ ...f.config })).toEqual({ useSandbox: false, forceSandbox: false });
    expect(await policy.requiresSandbox()).toBe(true);
    await expect(policy.assertHostExecution()).resolves.toBeUndefined();
    expect(await runtime.status(f.workspace)).toEqual({ mode: "tools" });
    await expect(policy.assertLegacyExecutionRequest(new Request("http://localhost/opencode/session", { method: "POST" }), "/opencode/session")).rejects.toMatchObject({ code: "sandbox_only" });
    await applySandboxSettings(f.config);
    await expect(policy.assertHostExecution()).rejects.toMatchObject({ code: "sandbox_only" });
    expect(await runtime.status(f.workspace)).toEqual({ mode: "only" });
    await writeSandboxSettings(f.config, { useSandbox: false, forceSandbox: false });
    expect(await readAppliedSandboxSettings(f.config)).toEqual({ useSandbox: true, forceSandbox: true });
    await expect(policy.assertHostExecution()).rejects.toMatchObject({ code: "sandbox_only" });
    const legacyRead = new Request("http://localhost/opencode/session");
    await expect(policy.assertLegacyExecutionRequest(legacyRead, "/opencode/session")).rejects.toMatchObject({ code: "sandbox_only" });
    await applySandboxSettings(f.config);
    await expect(policy.assertHostExecution()).resolves.toBeUndefined();
    await expect(policy.assertLegacyExecutionRequest(legacyRead, "/opencode/session")).resolves.toBeUndefined();
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
    const policy = managedDesktopPolicy(f.config, { sandboxFreshnessMs: 0 });
    await policy.setSession(session);
    await policy.current();
    expect(await policy.sandboxSettings()).toEqual({ useSandbox: false, forceSandbox: false, effectiveUseSandbox: true, effectiveForceSandbox: true, allowHostExecution: true, effectiveAllowHostExecution: false, managedUse: true, managedForce: true, managed: true, featureEnabled: true, verification: "verified" });
    expect(headers.every(header => header === "1")).toBe(true);
    await expect(policy.assertHostExecution()).rejects.toThrow("requires the sandbox");
    expect((await policy.computerRules()).map(rule => rule.effect)).toEqual(["deny", "deny", "deny", "deny"]);
    enabled = false;
    expect(await policy.sandboxSettings()).toMatchObject({ effectiveAllowHostExecution: false, managed: true, featureEnabled: false });
    unavailable = true;
    const restarted = managedDesktopPolicy({ ...f.config });
    await restarted.setSession({ ...session, token: "rotated-fixture-token" });
    expect(await restarted.sandboxSettings()).toMatchObject({ effectiveAllowHostExecution: false, managed: true, featureEnabled: false });
    unavailable = false;
    deny = false;
    expect(await policy.sandboxSettings()).toMatchObject({ effectiveAllowHostExecution: true, managed: false, featureEnabled: false });
    await writeSandboxSettings(f.config, { useSandbox: true, forceSandbox: true });
    expect(await policy.sandboxSettings()).toMatchObject({ allowHostExecution: false, effectiveAllowHostExecution: false, managed: false });
  } finally { await den.stop(); await f.cleanup(); }
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
  const policy = managedDesktopPolicy(f.config, { sandboxFreshnessMs: 0 });
  const runtime = createLocalSandboxRuntime(f.config);
  try {
    // Signed-out ordinary mode is unchanged, including when rollout cannot be read.
    await expect(policy.assertHostExecution()).resolves.toBeUndefined();
    await policy.setSession(session);
    await policy.current();
    expect(await policy.sandboxSettings()).toEqual({ useSandbox: false, forceSandbox: false, effectiveUseSandbox: true, effectiveForceSandbox: true, allowHostExecution: true, effectiveAllowHostExecution: false, managedUse: false, managedForce: false, managed: false, featureEnabled: false, verification: "unavailable" });
    await expect(policy.assertHostExecution()).rejects.toThrow("couldn't check your permissions");
    expect(await runtime.status(f.workspace)).toEqual({ mode: "only" });
    unavailable = false;
    expect(await policy.sandboxSettings()).toMatchObject({ effectiveAllowHostExecution: false, managed: true, featureEnabled: false });
    await expect(policy.assertHostExecution()).rejects.toThrow("requires the sandbox");
    required = false;
    expect(await policy.sandboxSettings()).toMatchObject({ effectiveAllowHostExecution: true, managed: false, featureEnabled: false });
    // Previously verified Allow can keep its ordinary offline behaviour for
    // this identity; a changed identity must verify again, never inherit it.
    unavailable = true;
    await expect(policy.assertHostExecution()).resolves.toBeUndefined();
    await policy.setSession({ ...session, token: "different-sign-in-fixture-token" });
    await expect(policy.assertHostExecution()).rejects.toThrow("couldn't check your permissions");
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
    const policy = managedDesktopPolicy(f.config, { sandboxFreshnessMs: 0 });
    expect(await policy.sandboxSettings()).toEqual({ useSandbox: false, forceSandbox: false, effectiveUseSandbox: false, effectiveForceSandbox: false, allowHostExecution: true, effectiveAllowHostExecution: true, managedUse: false, managedForce: false, managed: false, featureEnabled: true, verification: "verified" });
    enabled = false;
    await writeSandboxSettings(f.config, { useSandbox: true, forceSandbox: true });
    expect(await policy.sandboxSettings()).toEqual({ useSandbox: true, forceSandbox: true, effectiveUseSandbox: true, effectiveForceSandbox: true, allowHostExecution: false, effectiveAllowHostExecution: false, managedUse: false, managedForce: false, managed: false, featureEnabled: false, verification: "verified" });
    expect(calls).toEqual([{ path: "/v1/features", authorization: null }, { path: "/v1/features", authorization: null }]);
    f.config.trustedDenOrigin = `${f.config.trustedDenOrigin}/untrusted-path`;
    expect((await policy.localSandboxAccess()).enabled).toBe(false);
    expect(calls).toHaveLength(2);
  } finally { await den.stop(); await f.cleanup(); }
});

test("one short signed-out tool turn uses one feature read and a captured tool survives Use switching off", async () => {
  const f = await fixture();
  let featureReads = 0;
  const den = await serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    expect(new URL(request.url).pathname).toBe("/v1/features");
    featureReads++;
    return Response.json({ features: { sandboxTools: true } });
  } });
  f.config.trustedDenOrigin = `http://127.0.0.1:${den.port}`;
  const provider = createFakeProvider({ id: "microsandbox" });
  const runtime = createLocalSandboxRuntime(f.config, { externalDirectories: async () => ({}), provider: async () => provider });
  const policy = managedDesktopPolicy(f.config);
  const hooks = new Map<string, (event: SandboxInferenceEvent) => Promise<void>>();
  let prompt: (() => Promise<void>) | undefined;
  let transform: (() => void) | undefined;
  const tools = new Map<string, HostNativeTool>();
  const state = () => ({ tools: {}, system: [] });
  const context: SandboxPluginContext = {
    options: {},
    tool: {
      async transform(callback) {
        transform = () => { tools.clear(); callback({ list: () => [], remove() {}, add: tool => { tools.set(tool.name, tool); } }); };
        transform();
        return { async dispose() {} };
      },
      async reload() { transform?.(); },
    },
    session: { async hook(name, callback) {
      if (name === "prompt") prompt = callback;
      else hooks.set(name, callback);
      return { async dispose() {} };
    } },
  };
  try {
    const dispose = await setupSandboxTools(context, {
      async status() { return (await runtime.status(f.workspace)).mode; },
      assertHostExecution: () => policy.assertHostExecution(),
      execute: (name, input, call) => runtime.execute(f.workspace, name, input, call),
    });
    try {
      expect(tools.size).toBe(0);
      await writeSandboxSettings(f.config, { useSandbox: true, forceSandbox: false });
      featureReads = 0;
      await prompt?.();
      await hooks.get("context")?.(state());
      await hooks.get("generate")?.(state());
      const shell = tools.get("sandbox_shell");
      expect(shell).toBeDefined();
      const call = { sessionID: "one-tool-turn", signal: AbortSignal.timeout(2_000) };
      expect(await shell?.execute({ command: "true" }, call)).toMatchObject({ metadata: { sandbox: true } });
      await hooks.get("generate")?.(state());
      expect(featureReads).toBe(1);
      await writeSandboxSettings(f.config, { useSandbox: false, forceSandbox: false });
      expect(await shell?.execute({ command: "true" }, call)).toMatchObject({ metadata: { sandbox: true } });
      await prompt?.();
      expect(tools.size).toBe(0);
    } finally { await dispose(); }
  } finally { await runtime.close(); await den.stop(); await f.cleanup(); }
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
    for (const tool of ["execute", "patch", "browser_open", "computer_script", "custom_host_command", "drive_pull_file"]) await expect(before?.({ tool })).rejects.toThrow("can’t run with your sandbox setting");
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
    await expect(prompt?.()).rejects.toThrow("Restart OpenWork");
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
    await expect(retained?.execute({ command: "must not run" }, call)).rejects.toThrow("can’t run with your current sandbox setting");
    expect(hostRuns).toBe(1);
  } finally { await close(); }
});

test("initial bridge failure and missing guard primitives reject admission, never fall back to host catalog", async () => {
  const context: SandboxPluginContext = { options: {}, tool: { async transform() { throw new Error("must not expose tools"); }, async reload() {} }, session: { async hook() { throw new Error("must not admit prompt"); } } };
  await expect(setupSandboxTools(context, { status: async () => { throw new Error("bridge unavailable"); }, execute: async () => ({ content: [] }) })).rejects.toThrow("couldn’t enforce your sandbox setting");
  await expect(setupSandboxTools(context, { status: async () => "only", execute: async () => ({ content: [] }) })).rejects.toThrow("couldn’t enforce your sandbox setting");
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
    await writeSandboxSettings(f.config, { useSandbox: true, forceSandbox: true });
    await expect(policy.assertRequest(new Request("http://localhost/workspace/ws/files/raw"), "/workspace/ws/files/raw")).rejects.toThrow("This action can only run in the sandbox");
    await expect(policy.assertLegacyExecutionRequest(new Request("http://localhost/session"), "/session")).rejects.toThrow("This action can only run in the sandbox");
    const contextRequest = (body: unknown) => new Request(`http://localhost${contextPath}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await expect(policy.assertRequest(contextRequest({ value: "Use the six guest primitives." }), contextPath, true)).resolves.toBeUndefined();
    await expect(policy.assertRequest(contextRequest({ parts: [{ type: "file", url: "file:///host/secret" }] }), contextPath, true)).rejects.toThrow("This action can only run in the sandbox");
  } finally { await f.cleanup(); }
});

test("browser, computer and file-transfer bridges deny host dispatch for root and child sessions", async () => {
  const f = await fixture();
  await writeSandboxSettings(f.config, { useSandbox: true, forceSandbox: true });
  const { createV2ContextBridge } = await import("../src/opencode-v2-context-bridge.js");
  let hostCalls = 0;
  const bridge = await createV2ContextBridge(async () => { hostCalls++; return {}; }, undefined, undefined, undefined, f.config);
  const call = async (url: string, token: string, body: unknown) => {
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("This action can only run in the sandbox");
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
    access: async () => ({ enabled: true, scope: "fixture", hostDenied: true }), settings: async () => ({ useSandbox: true, forceSandbox: true }),
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
    await writeSandboxSettings(f.config, { useSandbox: true, forceSandbox: true });
    await expect(engine.assertSandboxReady(f.workspace)).rejects.toThrow("The sandbox is not ready");
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
  await writeSandboxSettings(f.config, { useSandbox: true, forceSandbox: true });
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

test("settings and folder GETs stay local while Den hangs, then report verified and unavailable", async () => {
  const f = await fixture();
  f.config.engineAutoUpgrade = false;
  const release = Promise.withResolvers<void>();
  let offline = false;
  const den = await serve({ hostname: "127.0.0.1", port: 0, fetch: async () => {
    await release.promise;
    return offline ? new Response(null, { status: 403 }) : Response.json({ features: { sandboxTools: true } });
  } });
  f.config.trustedDenOrigin = `http://127.0.0.1:${den.port}`;
  const { startServer } = await import("../src/server.js");
  const app = await startServer(f.config, { deferManagedEngineStartup: true });
  const headers = { authorization: `Bearer ${f.config.token}`, "content-type": "application/json" };
  const url = (name: string) => `http://127.0.0.1:${app.port}/workspace/ws_sandbox/${name}`;
  try {
    const files = await readdir(f.workspace);
    const folders = await fetch(url("authorized-folders"), { headers });
    expect(folders.status).toBe(200);
    expect(folders.headers.get("server-timing")).toMatch(/workspace;dur=.*db;dur=.*policy;dur=.*process;dur=/);
    const before = performance.now();
    const response = await fetch(url("sandbox-settings"), { headers, signal: AbortSignal.timeout(500) });
    expect(performance.now() - before).toBeLessThan(50);
    expect(response.headers.get("server-timing")).toMatch(/workspace;dur=.*db;dur=.*policy;dur=.*process;dur=/);
    expect(await response.json()).toMatchObject({ verification: "checking", featureEnabled: false, effectiveUseSandbox: false });
    expect(await readdir(f.workspace)).toEqual(files);
    const policy = managedDesktopPolicy(f.config);
    release.resolve();
    await policy.localSandboxAccess();
    expect(await (await fetch(url("sandbox-settings"), { headers })).json()).toMatchObject({ verification: "verified", featureEnabled: true });
    const put = async (body: unknown) => fetch(url("sandbox-settings"), { method: "PUT", headers, body: JSON.stringify(body) });
    for (const body of [{}, { useSandbox: 1 }, { useSandbox: false, allowHostExecution: false }]) {
      expect((await put(body)).status).toBe(400);
    }
    const use = await put({ useSandbox: true });
    expect(use.status).toBe(200);
    expect(use.headers.get("server-timing")).toMatch(/workspace;dur=.*db;dur=.*policy;dur=.*process;dur=/);
    expect(await use.json()).toMatchObject({ useSandbox: true, forceSandbox: false, effectiveUseSandbox: true, pending: false });
    const force = await put({ forceSandbox: true });
    expect(force.status).toBe(200);
    expect(await force.json()).toMatchObject({ useSandbox: true, forceSandbox: true, effectiveForceSandbox: true });
    const off = await put({ useSandbox: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ useSandbox: false, forceSandbox: false });
    await expect.poll(async () => (await fetch(url("sandbox-settings"), { headers })).json())
      .toMatchObject({ useSandbox: false, forceSandbox: false, effectiveForceSandbox: false, pending: false });
    expect(await (await fetch(url("sandbox-status"), { headers })).json()).toMatchObject({ mode: "off", state: "off" });
    offline = true;
    await writeSandboxSettings(f.config, { useSandbox: false, forceSandbox: false });
    await policy.localSandboxAccess();
    const unavailable = await fetch(url("sandbox-settings"), { headers });
    expect(await unavailable.json()).toMatchObject({ verification: "unavailable", featureEnabled: true, useSandbox: false });
  } finally { release.resolve(); await app.stop(); await den.stop(); await f.cleanup(); }
});

test("sandbox settings GET backs off failed rollout verification and recovers without losing Force authority", async () => {
  const f = await fixture();
  f.config.engineAutoUpgrade = false;
  const now = performance.now.bind(performance);
  let offset = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now() + offset);
  let reads = 0;
  let release = Promise.withResolvers<void>();
  const den = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (new URL(request.url).pathname === "/v1/me/desktop-config") {
      return Response.json({ agentPermissions: { rules: [{ action: "host_execution", resource: "*", effect: "deny", source: "Everyone" }] } });
    }
    const round = ++reads;
    await release.promise;
    return round <= 2 ? new Response(null, { status: 403 }) : Response.json({ features: { sandboxTools: true } });
  } });
  const policy = managedDesktopPolicy(f.config);
  const { startServer } = await import("../src/server.js");
  const app = await startServer(f.config, { deferManagedEngineStartup: true });
  const read = async () => (await fetch(`http://127.0.0.1:${app.port}/workspace/ws_sandbox/sandbox-settings`, {
    headers: { authorization: `Bearer ${f.config.token}` },
  })).json();
  const restrictive = { managedForce: true, effectiveForceSandbox: true };
  try {
    await policy.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, orgId: "fixture", token: "fixture" });
    await policy.current();
    const finish = async () => {
      const inFlight = policy.localSandboxAccess();
      release.resolve();
      const result = await inFlight;
      expect(result).toMatchObject({ hostDenied: true, hostPolicyVerified: true });
      release = Promise.withResolvers<void>();
    };
    expect(await read()).toMatchObject({ verification: "checking", ...restrictive });
    await finish();
    expect(await read()).toMatchObject({ verification: "unavailable", featureEnabled: false, ...restrictive });
    expect(reads).toBe(1);
    offset += 2_000;
    expect(await read()).toMatchObject({ verification: "checking", ...restrictive });
    await finish();
    offset += 2_000;
    expect(await read()).toMatchObject({ verification: "unavailable", ...restrictive });
    expect(reads).toBe(2);
    offset += 2_000;
    expect(await read()).toMatchObject({ verification: "checking", ...restrictive });
    await finish();
    expect(await read()).toMatchObject({ verification: "verified", featureEnabled: true, ...restrictive });
    expect(reads).toBe(3);
  } finally { release.resolve(); clock.mockRestore(); await app.stop(); await den.stop(); await f.cleanup(); }
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
    await managedDesktopPolicy(f.config).localSandboxAccess();
    expect(await (await fetch(route, { headers })).json()).toEqual({ useSandbox: false, forceSandbox: false, effectiveUseSandbox: false, effectiveForceSandbox: false, allowHostExecution: true, effectiveAllowHostExecution: true, pending: false, managedUse: false, managedForce: false, managed: false, featureEnabled: false, verification: "unavailable" });
    const pending = fetch(route, { method: "PUT", headers, body: JSON.stringify({ allowHostExecution: false }) });
    let approvalId: string | undefined;
    for (let attempt = 0; attempt < 50 && !approvalId; attempt++) {
      const approvals = await (await fetch(`${root}/approvals`, { headers: hostHeaders })).json();
      approvalId = approvals.items?.find((item: { action: string }) => item.action === "config.sandbox_settings.write")?.id;
      if (!approvalId) await delay(10);
    }
    expect(approvalId).toBeTruthy();
    expect(await readSandboxSettings(f.config)).toEqual({ useSandbox: false, forceSandbox: false });
    await fetch(`${root}/approvals/${approvalId}`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ reply: "allow" }) });
    const updated = await pending;
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ useSandbox: true, forceSandbox: true, effectiveUseSandbox: true, effectiveForceSandbox: true, allowHostExecution: false, effectiveAllowHostExecution: false, pending: false, managedUse: false, managedForce: false, managed: false, featureEnabled: false, verification: "unavailable" });
    expect(await readSandboxSettings(f.config)).toEqual({ useSandbox: true, forceSandbox: true });
    expect((await fetch(`${root}/workspace/ws_sandbox/files/raw?path=missing.txt`, { headers })).status).toBe(403);
    expect((await fetch(route, { method: "PUT", headers, body: JSON.stringify({ allowHostExecution: "yes" }) })).status).toBe(400);
  } finally {
    await server.stop(); await f.cleanup();
    if (previewOverride === undefined) delete process.env.OPENWORK_ENGINE_V2_PREVIEW;
    else process.env.OPENWORK_ENGINE_V2_PREVIEW = previewOverride;
  }
});

test("host checks observe a new deny while an older rollout read is still held", async () => {
  const f = await fixture();
  const orgStarted = Promise.withResolvers<void>();
  const releaseOrg = Promise.withResolvers<void>();
  let deny = false, orgFinished = false;
  const den = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (new URL(request.url).pathname === "/v1/org") {
      orgStarted.resolve();
      await releaseOrg.promise;
      orgFinished = true;
      return Response.json({ features: { sandboxTools: true } });
    }
    return Response.json({ agentPermissions: { rules: deny ? [{ action: "host_execution", resource: "*", effect: "deny", source: "Everyone" }] : [] } });
  } });
  const policy = managedDesktopPolicy(f.config, { sandboxFreshnessMs: 100 });
  try {
    await policy.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, orgId: "org_fixture", token: "fixture" });
    const rollout = policy.localSandboxAccess();
    await orgStarted.promise;
    expect(await Promise.race([policy.assertHostExecution().then(() => "allowed"), delay(300, "blocked on rollout")])).toBe("allowed");
    deny = true;
    await delay(110);
    await expect(Promise.race([policy.assertHostExecution(), delay(300, "blocked on rollout")])).rejects.toMatchObject({ code: "sandbox_only" });
    expect(orgFinished).toBe(false);
    releaseOrg.resolve();
    expect(await rollout).toMatchObject({ hostDenied: true });
  } finally { releaseOrg.resolve(); await den.stop(); await f.cleanup(); }
});

test("Force-off stays restrictive during a held and failed replacement; settings PUT never waits", async () => {
  const f = await fixture();
  f.config.engineAutoUpgrade = false;
  f.config.freshInstallEngine = "v2";
  const releaseDen = Promise.withResolvers<void>();
  const den = await serve({ hostname: "127.0.0.1", port: 0, fetch: async () => {
    await releaseDen.promise;
    return Response.json({ features: { sandboxTools: false } });
  } });
  f.config.trustedDenOrigin = `http://127.0.0.1:${den.port}`;
  const env = { OPENWORK_ENGINE_V2_PREVIEW: "1", OPENWORK_ENGINE_V2_CHAT: "1", OPENWORK_OPENCODE2_BIN: "fixture" };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const entered = Promise.withResolvers<void>();
  const releaseStart = Promise.withResolvers<void>();
  const native = await import("../src/managed-opencode-v2.js");
  let starts = 0;
  let running = true;
  const nativeStart = vi.spyOn(native, "createManagedOpencodeV2Server").mockImplementation(async options => {
    if (++starts > 1) {
      expect(await options.isolateProjectConfig?.()).toBe(false);
      entered.resolve();
      await releaseStart.promise;
      throw new Error("Fixture restart failed");
    }
    let models: { providerID: string; id: string }[] = [];
    return {
      url: "http://127.0.0.1:1", username: "fixture", password: "fixture", childPid: 1, exitCode: null, stdout: "", stderr: "",
      projectConfigDisabled: true, health: async () => ({ healthy: true, version: "2.2.6", pid: 1 }),
      fetchJson: async path => ({ status: 200, json: { data: path === "/api/model" ? models : path.startsWith("/api/experimental/job") ? [] : path === "/api/session/active" && running ? { ses_busy: { type: "running" } } : {} } }),
      async setProviders(specs) { models = specs.flatMap(spec => spec.models.map(model => ({ providerID: spec.id, id: model.id }))); },
      async injectProvider() {}, async setSkills() {}, async refreshConfig() {}, async close() {},
    };
  });
  await writeSandboxSettings(f.config, { useSandbox: true, forceSandbox: true });
  const { startServer } = await import("../src/server.js");
  const app = await startServer(f.config);
  const policy = managedDesktopPolicy(f.config);
  const { createSandboxToolsBridge } = await import("../src/sandbox-tools-bridge.js");
  const bridge = await createSandboxToolsBridge(f.config);
  const hostRequest = () => fetch(bridge.url, { method: "POST", headers: { Authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ operation: "host", directory: f.workspace }) });
  const headers = { authorization: `Bearer ${f.config.token}`, "content-type": "application/json" };
  const url = `http://127.0.0.1:${app.port}/workspace/ws_sandbox/sandbox-settings`;
  const status = `http://127.0.0.1:${app.port}/experimental/engine-v2-preview/status`;
  try {
    await expect.poll(async () => (await (await fetch(status, { headers })).json()).running).toBe(true);
    const before = performance.now();
    const put = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ useSandbox: false }) });
    expect(performance.now() - before).toBeLessThan(200);
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ forceSandbox: false, pending: true, effectiveForceSandbox: true });
    for (const path of [
      "opencode2/api/session", "opencode2/api/session/ses_busy/prompt", "opencode2/api/session/ses_busy/command",
      "opencode/session", "opencode/session/ses_busy/prompt_async", "opencode/session/ses_busy/command",
    ]) {
      const response = await fetch(`http://127.0.0.1:${app.port}/workspace/ws_sandbox/${path}`, { method: "POST", headers, body: "{}" });
      expect(response.status, path).toBe(409);
      expect(await response.json(), path).toMatchObject({ code: "sandbox_engine_policy_pending", message: "Your sandbox setting is saved and applies when current tasks finish. Send this again then." });
    }
    running = false;
    await entered.promise;
    await expect(policy.assertHostExecution()).rejects.toMatchObject({ code: "sandbox_only" });
    expect(await policy.computerRules()).toContainEqual(expect.objectContaining({ effect: "deny" }));
    expect(await policy.websiteRules()).toContainEqual(expect.objectContaining({ effect: "deny" }));
    expect((await hostRequest()).status).toBe(503);
    releaseStart.resolve();
    await expect.poll(async () => (await (await fetch(status, { headers })).json()).lastError).toContain("Fixture restart failed");
    expect(await (await fetch(url, { headers })).json()).toMatchObject({ pending: true, effectiveForceSandbox: true });
    expect((await hostRequest()).status).toBe(503);
  } finally {
    releaseStart.resolve(); releaseDen.resolve();
    await bridge.close(); await app.stop(); await den.stop();
    nativeStart.mockRestore();
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await f.cleanup();
  }
});
