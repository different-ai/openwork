import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { readAuditEntries } from "./audit.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { opencodeConfigPath } from "./workspace-files.js";
import { readWorkspaceRunMode, runModeFromPermissionBlock, setWorkspaceRunMode, type WorkspaceRunMode } from "./workspace-run-mode.js";

const roots: string[] = [];
const stops: Array<() => void | Promise<void>> = [];
const savedEnv = {
  OPENWORK_DATA_DIR: process.env.OPENWORK_DATA_DIR,
  OPENWORK_TOKEN_STORE: process.env.OPENWORK_TOKEN_STORE,
  OPENWORK_ENGINE_V2_PREVIEW: process.env.OPENWORK_ENGINE_V2_PREVIEW,
};
const headers = { authorization: "Bearer owt_run_mode", "content-type": "application/json" };
const hostHeaders = { "x-openwork-host-token": "owt_run_mode_host", "content-type": "application/json" };

async function workspaceRoot(content?: string) {
  const root = await mkdtemp(join(tmpdir(), "openwork-run-mode-"));
  roots.push(root);
  if (content !== undefined) await writeFile(join(root, "opencode.json"), content);
  return root;
}

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("workspace run mode file", () => {
  test("default means no catch-all, never deny or an unsupported rule shape", () => {
    expect(runModeFromPermissionBlock(undefined)).toEqual({ mode: "default", catchAll: null, supported: true });
    expect(runModeFromPermissionBlock({ bash: { "rm *": "deny" } })).toEqual({ mode: "default", catchAll: null, supported: true });
    expect(runModeFromPermissionBlock("allow")).toEqual({ mode: "run-everything", catchAll: "allow", supported: true });
    expect(runModeFromPermissionBlock({ "*": "ask" })).toEqual({ mode: "approve", catchAll: "ask", supported: true });
    for (const block of ["deny", { "*": "deny" }, { "*": { "*": "allow" } }, { "*": null }, null, [], false, "invalid", { bash: 1 }, { edit: { "*": [] } }]) {
      expect(runModeFromPermissionBlock(block)).toMatchObject({ mode: null, supported: false });
    }
  });

  test("creates the preferred config only when needed and keeps shorthand spelling", async () => {
    const root = await workspaceRoot();
    expect(await setWorkspaceRunMode(root, "default")).toBe(false);
    await expect(readFile(opencodeConfigPath(root))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await setWorkspaceRunMode(root, "approve")).toBe(true);
    expect(opencodeConfigPath(root)).toBe(join(root, "opencode.jsonc"));
    expect(parse(await readFile(opencodeConfigPath(root), "utf8"))).toEqual({ permission: { "*": "ask" } });
    expect(await setWorkspaceRunMode(root, "approve")).toBe(false);
    const shorthand = await workspaceRoot('{ /* root */ "permission" /* key */ : /* value */ "allow", // trailing\n "model": "local/model" }');
    expect(await setWorkspaceRunMode(shorthand, "approve")).toBe(true);
    expect(parse(await readFile(opencodeConfigPath(shorthand), "utf8"))).toEqual({ permission: "ask", model: "local/model" });
    expect(await setWorkspaceRunMode(shorthand, "default")).toBe(true);
    const content = await readFile(opencodeConfigPath(shorthand), "utf8");
    expect(parse(content)).toEqual({ model: "local/model" });
    for (const comment of ["/* root */", "/* key */", "/* value */", "// trailing"]) expect(content).toContain(comment);
  });

  test("places even an unchanged trailing catch-all before narrow rules without deleting comments", async () => {
    const narrow = '"bash": { /* pattern */ "rm *": "deny", "git status": "allow" }';
    for (const block of [
      `// narrow\n${narrow}, // catch-all\n"*" /* key, */ : /* value */ "allow" // end`,
      `"*": "allow", /* narrow */ ${narrow},`,
      `"edit": "ask", "*": "allow", // narrow\n${narrow}`,
      `/* narrow */ ${narrow}`,
      `/* empty */`,
    ]) {
      const root = await workspaceRoot(`{\r\n // root\r\n "permission": {${block}\n}, "model": "local/model"\r\n}`);
      const before = await readFile(opencodeConfigPath(root), "utf8");
      await setWorkspaceRunMode(root, "run-everything");
      const content = await readFile(opencodeConfigPath(root), "utf8");
      const errors: { error: number; offset: number; length: number }[] = [];
      const data = parse(content, errors, { allowTrailingComma: true });
      expect(errors).toEqual([]);
      expect(Object.keys(data.permission)[0]).toBe("*");
      expect(data.model).toBe("local/model");
      if (block.includes(narrow)) expect(content).toContain(narrow);
      for (const comment of before.match(/\/\*[^]*?\*\/|\/\/[^\r\n]*/g) ?? []) expect(content).toContain(comment);
      expect(await setWorkspaceRunMode(root, "run-everything")).toBe(false);
      expect(await readFile(opencodeConfigPath(root), "utf8")).toBe(content);
      expect(await setWorkspaceRunMode(root, "default")).toBe(true);
      const restored = await readFile(opencodeConfigPath(root), "utf8");
      expect(parse(restored, [], { allowTrailingComma: true }).permission["*"]).toBeUndefined();
      if (block.includes(narrow)) expect(restored).toContain(narrow);
      for (const comment of before.match(/\/\*[^]*?\*\/|\/\/[^\r\n]*/g) ?? []) expect(restored).toContain(comment);
    }
  });

  test("rejects invalid JSONC, duplicate keys, and unsupported shapes without touching bytes", async () => {
    for (const content of [
      "{ broken", "[]", "null", "", '{"permission":"deny"}', '{"permission":{"*":{"*":"ask"}}}',
      '{"permission":{ "*":"allow", "*":"ask" }}', '{"permission":{},"permission":{}}',
      '{"permission":{"bash":{"*":"ask","*":"deny"}}}', '{"permission":{"edit":false}}',
    ]) {
      const root = await workspaceRoot(content);
      expect(await readWorkspaceRunMode(root)).toMatchObject({ mode: null, supported: false });
      const modes: WorkspaceRunMode[] = ["default", "approve", "run-everything"];
      for (const mode of modes) {
        await expect(setWorkspaceRunMode(root, mode)).rejects.toMatchObject({ status: 409, code: "workspace_run_mode_unsupported" });
        expect(await readFile(opencodeConfigPath(root), "utf8")).toBe(content);
      }
    }
  });
});

async function startModeServer(options: { readOnly?: boolean; approval?: ServerConfig["approval"]; engine?: boolean } = {}) {
  const root = await workspaceRoot('{"permission":{"edit":"deny"},"model":"local/model"}');
  process.env.OPENWORK_DATA_DIR = join(root, "data");
  process.env.OPENWORK_TOKEN_STORE = join(root, "tokens.json");
  delete process.env.OPENWORK_ENGINE_V2_PREVIEW;
  const engineState: { statuses: unknown; permissions: unknown[]; questions: unknown[]; statusCode: number; disposeCode: number; agentCode: number; disposals: number; probes: string[] } = {
    statuses: {}, permissions: [], questions: [], statusCode: 200, disposeCode: 200, agentCode: 200, disposals: 0, probes: [],
  };
  const engine = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (["/session/status", "/permission", "/question", "/instance/dispose"].includes(url.pathname)) engineState.probes.push(url.searchParams.get("directory") ?? "");
      if (url.pathname === "/session/status") return Response.json(engineState.statuses, { status: engineState.statusCode });
      if (url.pathname === "/permission") return Response.json(engineState.permissions);
      if (url.pathname === "/question") return Response.json(engineState.questions);
      if (url.pathname === "/instance/dispose") {
        engineState.disposals++;
        return Response.json(true, { status: engineState.disposeCode });
      }
      if (url.pathname === "/config") return Response.json({ default_agent: "build" });
      if (url.pathname === "/agent") return Response.json([{ name: "build", mode: "primary", permission: [] }], { status: engineState.agentCode });
      if (url.pathname === "/mcp") return Response.json({});
      return Response.json({}, { status: 404 });
    },
  });
  stops.push(() => engine.stop(true));
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, configPath: join(root, "server.json"), token: "owt_run_mode", hostToken: "owt_run_mode_host",
    approval: options.approval ?? { mode: "auto", timeoutMs: 1_000 }, corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local", ...(options.engine === false ? {} : { baseUrl: `http://127.0.0.1:${engine.port}` }) }],
    authorizedRoots: [root], readOnly: options.readOnly ?? false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const server = await startServer(config);
  stops.push(() => server.stop());
  const origin = `http://127.0.0.1:${server.port}`;
  const base = `${origin}/workspace/ws_1/permissions/mode`;
  const put = (mode: string) => fetch(base, { method: "PUT", headers, body: JSON.stringify({ mode }) });
  return { root, origin, base, put, engineState };
}

describe("workspace run mode API", () => {
  test("authenticates, preserves narrower rules, audits, emits config events, and reloads idle engines", async () => {
    const { root, origin, base, put, engineState } = await startModeServer();
    expect((await fetch(base)).status).toBe(401);
    expect(await (await fetch(base, { headers })).json()).toEqual({ mode: "default", catchAll: null, supported: true, path: opencodeConfigPath(root), refreshPending: false });
    const changed = await put("run-everything");
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ mode: "run-everything", catchAll: "allow", supported: true, changed: true, refresh: "reloaded" });
    expect(parse(await readFile(opencodeConfigPath(root), "utf8"))).toEqual({ permission: { "*": "allow", edit: "deny" }, model: "local/model" });
    expect(engineState.disposals).toBe(1);
    expect(engineState.probes.every((directory) => directory === root)).toBe(true);
    expect(await (await put("run-everything")).json()).toMatchObject({ changed: false, refresh: "skipped" });
    expect(engineState.disposals).toBe(1);
    expect(await (await put("default")).json()).toMatchObject({ mode: "default", catchAll: null, changed: true, refresh: "reloaded" });
    expect((await put("unknown")).status).toBe(400);
    expect((await readAuditEntries(root, "ws_1")).some((entry) => entry.action === "config.write" && entry.target === opencodeConfigPath(root))).toBe(true);
    const events = await (await fetch(`${origin}/workspace/ws_1/events`, { headers })).json();
    expect(events.items.some((entry: { reason: string }) => entry.reason === "config")).toBe(true);
    const issued = await (await fetch(`${origin}/tokens`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ scope: "viewer", label: "viewer" }) })).json();
    const viewerHeaders = { ...headers, authorization: `Bearer ${issued.token}` };
    expect((await fetch(base, { headers: viewerHeaders })).status).toBe(200);
    const before = await readFile(opencodeConfigPath(root), "utf8");
    expect((await fetch(base, { method: "PUT", headers: viewerHeaders, body: JSON.stringify({ mode: "approve" }) })).status).toBe(403);
    expect(await readFile(opencodeConfigPath(root), "utf8")).toBe(before);
  });

  test("refuses other busy sessions, retries, permission waits, questions, and unknown activity before writing", async () => {
    const { root, put, engineState } = await startModeServer();
    const before = await readFile(opencodeConfigPath(root), "utf8");
    for (const statuses of [{ current: { type: "idle" }, other: { type: "busy" } }, { child: { type: "retry", attempt: 1 } }]) {
      engineState.statuses = statuses;
      expect(await (await put("run-everything")).json()).toMatchObject({ code: "workspace_run_mode_busy" });
    }
    engineState.statuses = {};
    engineState.permissions = [{ id: "permission_1", sessionID: "other" }];
    expect((await put("approve")).status).toBe(409);
    engineState.permissions = [];
    engineState.questions = [{ id: "question_1", sessionID: "other" }];
    expect((await put("approve")).status).toBe(409);
    engineState.questions = [];
    engineState.statuses = [];
    expect(await (await put("approve")).json()).toMatchObject({ code: "workspace_run_mode_activity_unknown" });
    engineState.statusCode = 503;
    expect((await put("approve")).status).toBe(409);
    expect(await readFile(opencodeConfigPath(root), "utf8")).toBe(before);
    expect(engineState.disposals).toBe(0);
    expect(await readAuditEntries(root, "ws_1")).toEqual([]);
  });

  test("reports deferred after failed reload or snapshot and retries an unchanged saved mode", async () => {
    const { put, engineState } = await startModeServer();
    engineState.disposeCode = 503;
    expect(await (await put("approve")).json()).toMatchObject({ mode: "approve", changed: true, refresh: "deferred", reason: expect.any(String) });
    engineState.disposeCode = 200;
    engineState.agentCode = 503;
    expect(await (await put("approve")).json()).toMatchObject({ changed: false, refresh: "deferred" });
    engineState.agentCode = 200;
    expect(await (await put("approve")).json()).toMatchObject({ changed: false, refresh: "reloaded" });
    expect(await (await put("approve")).json()).toMatchObject({ changed: false, refresh: "skipped" });
  });

  test("reports saved but deferred when no engine is configured", async () => {
    const { put } = await startModeServer({ engine: false });
    expect(await (await put("approve")).json()).toMatchObject({ mode: "approve", changed: true, refresh: "deferred" });
  });

  test("blocks unsupported configs and the live v2 chat-routing flag without touching the file", async () => {
    const { root, origin, base, put, engineState } = await startModeServer();
    for (const content of ['{"permission":"deny"}', '{"permission":{"*":{}}}', '{"permission":']) {
      await writeFile(opencodeConfigPath(root), content);
      expect(await (await fetch(base, { headers })).json()).toMatchObject({ mode: null, supported: false, reason: expect.any(String) });
      expect((await put("default")).status).toBe(409);
      expect(await readFile(opencodeConfigPath(root), "utf8")).toBe(content);
    }
    const valid = '{"permission":"ask"}';
    await writeFile(opencodeConfigPath(root), valid);
    const toggle = await fetch(`${origin}/experimental/engine-v2-preview`, { method: "PUT", headers, body: JSON.stringify({ chatRouting: true }) });
    expect(toggle.status).toBe(200);
    expect(await (await fetch(base, { headers })).json()).toMatchObject({ mode: "approve", supported: false, reason: expect.stringContaining("v2") });
    expect((await put("run-everything")).status).toBe(409);
    expect(await readFile(opencodeConfigPath(root), "utf8")).toBe(valid);
    expect(engineState.disposals).toBe(0);
  });

  test("keeps the read-only and config.write approval gates", async () => {
    const readOnly = await startModeServer({ readOnly: true });
    expect((await readOnly.put("approve")).status).toBe(403);
    const approval = await startModeServer({ approval: { mode: "manual", timeoutMs: 30 } });
    const before = await readFile(opencodeConfigPath(approval.root), "utf8");
    expect((await approval.put("approve")).status).toBe(403);
    expect(await readFile(opencodeConfigPath(approval.root), "utf8")).toBe(before);
    expect(approval.engineState.disposals).toBe(0);
  });

  test("rechecks workspace activity after config.write approval", async () => {
    const { root, origin, put, engineState } = await startModeServer({ approval: { mode: "manual", timeoutMs: 2_000 } });
    const before = await readFile(opencodeConfigPath(root), "utf8");
    const pending = put("approve");
    let approvalId: string | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      const approvals = await (await fetch(`${origin}/approvals`, { headers: { ...headers, ...hostHeaders } })).json();
      const approval = approvals.items[0];
      if (approval) {
        expect(approval).toMatchObject({ action: "config.write", workspaceId: "ws_1", paths: [opencodeConfigPath(root)] });
        approvalId = approval.id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(approvalId).toBeDefined();
    engineState.statuses = { other: { type: "busy" } };
    const approved = await fetch(`${origin}/approvals/${approvalId}`, { method: "POST", headers: { ...headers, ...hostHeaders }, body: JSON.stringify({ reply: "allow" }) });
    expect(approved.status).toBe(200);
    expect((await pending).status).toBe(409);
    expect(await readFile(opencodeConfigPath(root), "utf8")).toBe(before);
    expect(engineState.disposals).toBe(0);
  });
});
