import { describe, expect, test } from "bun:test";
import type { AgentPermissionRule } from "@openwork/types/den/agent-permissions-runtime";
import { agentPermissionEngineV2Decision, agentPermissionEngineV2Rules } from "../src/agent-permission-engine.js";
import { agentPermissionRulesForActions, managedDesktopPolicy } from "../src/managed-desktop-policy.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyOpencodeRequest } from "../src/server.js";
import { ApiError } from "../src/errors.js";
import type { ServerConfig, WorkspaceInfo } from "../src/types.js";
import { writeGlobalRuntimeOpencodeConfig, writeManagedDesktopPolicy } from "../src/runtime-opencode-config-store.js";
import { withoutAgentHarnessRules } from "@openwork/types/den/agent-permissions-runtime";

const outside: AgentPermissionRule = { action: "external_directory", resource: "*", effect: "deny", source: "Contractors" };

test("legacy forwarding fails closed for Block and Ask, regardless of local config; no rules keeps v1 available", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legacy-folder-policy-"));
  const previous = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(directory, "runtime.sqlite");
  let rules: AgentPermissionRule[] = [];
  let unavailable = false;
  let forwarded = 0;
  const den = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => unavailable
    ? new Response(null, { status: 500 }) : Response.json({ agentPermissions: { rules } }) });
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    forwarded++;
    return Response.json({ accepted: true });
  } });
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(directory, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    opencodeBaseUrl: `http://127.0.0.1:${engine.port}`,
  };
  const workspace: WorkspaceInfo = { id: "workspace", name: "Test", path: directory, preset: "", workspaceType: "local", baseUrl: config.opencodeBaseUrl };
  const policy = managedDesktopPolicy(config);
  const requestFor = (path: string, method = "POST") => new Request(`http://127.0.0.1${path}`, {
    method, ...(["GET", "HEAD"].includes(method) ? {} : { body: JSON.stringify({
      agent: "local-unrestricted", permission: { external_directory: "allow" },
      parts: [{ type: "text", text: "Read /outside/secret" }],
    }) }),
  });
  const forward = (path: string, method = "POST") => {
    const request = requestFor(path, method);
    return proxyOpencodeRequest({ config, workspace, request, url: new URL(request.url), proxyPath: path });
  };
  const rejected = async (path: string, method = "POST") => {
    let denied = false;
    try { await forward(path, method); }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      expect(error.status).toBe(403);
      expect(error.code).toBe("organization_policy_denied");
      expect(error.message).toContain("set for Contractors");
      expect(error.message).toContain("Use the default OpenCode v2 engine");
      denied = true;
    }
    expect(denied).toBe(true);
    expect(forwarded).toBe(0);
  };
  try {
    // Neither the project nor the editable runtime row can loosen the guard.
    await writeFile(join(directory, "opencode.json"), JSON.stringify({ permission: { external_directory: "allow" } }));
    await writeGlobalRuntimeOpencodeConfig(config, (current) => ({ ...current, permission: { external_directory: { "*": "allow" } } }));
    // Another host/sign-in previously verified Allow for a different org and
    // left it in the shared runtime DB. This new service has no bound policy.
    rules = [{ ...outside, effect: "allow", source: "Previous organization" }];
    const previousIdentityPolicy = managedDesktopPolicy({ ...config });
    await previousIdentityPolicy.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, orgId: "org_previous", token: "den-previous" });
    await previousIdentityPolicy.current();
    unavailable = true;
    await policy.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, orgId: "org_test", token: "den-test" });
    // Neither a previous org's persisted Allow nor a persisted empty policy
    // can stand in for verification of this sign-in when Den is unavailable.
    await expect(forward("/opencode/session/chat/prompt_async")).rejects.toMatchObject({ status: 403, code: "policy_unavailable" });
    expect(forwarded).toBe(0);
    await writeManagedDesktopPolicy(config, { agentPermissions: { rules: [] } });
    await expect(forward("/opencode/session/chat/prompt_async")).rejects.toMatchObject({ status: 403, code: "policy_unavailable" });
    expect(forwarded).toBe(0);
    unavailable = false;
    for (const effect of ["deny", "ask"] satisfies AgentPermissionRule["effect"][]) {
      rules = [{ ...outside, effect }];
      await policy.current();
      for (const suffix of ["prompt_async", "message", "command", "shell", "summarize"]) {
        await rejected(`/opencode/session/chat/${suffix}`);
        await rejected(`/opencode/api/session/chat/${suffix}`);
      }
      await rejected("/opencode/session/chat/permissions/request");
      await rejected("/opencode/permission/request/reply");
      await rejected("/opencode/pty");
      await rejected("/opencode/pty/terminal/connect", "GET");
      await rejected("/opencode/config", "PATCH");
      // History reads and Stop remain usable under both restrictive decisions.
      await expect(policy.assertLegacyExecutionRequest(requestFor("/opencode/session/chat/message", "GET"), "/opencode/session/chat/message")).resolves.toBeUndefined();
      await expect(policy.assertLegacyExecutionRequest(requestFor("/opencode/session/chat/abort"), "/opencode/session/chat/abort")).resolves.toBeUndefined();
    }
    // A lost Den connection cannot silently drop a restriction already verified.
    unavailable = true;
    await rejected("/opencode/session/chat/prompt_async");
    unavailable = false;
    // Den's kill-switch projection, no setting, and Allow add no restrictions.
    for (const delivered of [withoutAgentHarnessRules([outside]), [], [{ ...outside, effect: "allow" }]]) {
      rules = delivered;
      await policy.current();
      expect(await (await forward("/opencode/session/chat/prompt_async")).json()).toEqual({ accepted: true });
    }
    expect(forwarded).toBe(3);
    // In-memory verification for this exact sign-in still works offline.
    unavailable = true;
    expect(await (await forward("/opencode/session/chat/prompt_async")).json()).toEqual({ accepted: true });
    expect(forwarded).toBe(4);
    // An org switch discards that Allow, even though the previous sign-in was
    // verified. A new token in the same org must also verify independently.
    for (const identity of [{ orgId: "org_other", token: "den-other" }, { orgId: "org_other", token: "den-other-new-token" }]) {
      await policy.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, ...identity });
      await expect(forward("/opencode/session/chat/prompt_async")).rejects.toMatchObject({ status: 403, code: "policy_unavailable" });
      expect(forwarded).toBe(4);
      unavailable = false;
      await policy.current();
      unavailable = true;
      await expect(policy.assertLegacyExecutionRequest(requestFor("/opencode/session/chat/prompt_async"), "/opencode/session/chat/prompt_async")).resolves.toBeUndefined();
    }
    unavailable = false;
    // Signing out ends policy enforcement; overrides themselves are not removed.
    rules = [outside];
    await policy.current();
    await policy.clearSession();
    await expect(policy.assertLegacyExecutionRequest(requestFor("/opencode/session/chat/prompt_async"), "/opencode/session/chat/prompt_async")).resolves.toBeUndefined();
  } finally {
    den.stop(true);
    engine.stop(true);
    await policy.clearSession();
    if (previous === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

describe("outside workspace permissions on OpenCode v2", () => {
  test("native denials ask so the plugin can explain the organization rule", () => {
    expect(agentPermissionEngineV2Rules([outside])).toEqual([{ action: "external_directory", resource: "*", effect: "ask" }]);
    expect(agentPermissionEngineV2Decision([outside], "external_directory", ["*"], "allow")).toEqual({
      effect: "deny", message: "Your organization's agent permissions block folders outside the workspace (set for Contractors).",
    });
  });
  test("ask stays ask even when the engine allows, and never weakens an engine denial", () => {
    const rule: AgentPermissionRule = { ...outside, effect: "ask" };
    expect(agentPermissionEngineV2Rules([rule])).toEqual([{ action: "external_directory", resource: "*", effect: "ask" }]);
    expect(agentPermissionEngineV2Decision([rule], "external_directory", ["/outside"], "allow")).toEqual({ effect: "ask" });
    expect(agentPermissionEngineV2Decision([rule], "external_directory", ["/outside"], "deny")).toEqual({ effect: "deny" });
  });
  test("without rules the engine decision is unchanged", () => {
    for (const effect of ["allow", "ask", "deny"] satisfies ("allow" | "ask" | "deny")[]) {
      expect(agentPermissionEngineV2Decision([], "external_directory", ["/outside"], effect)).toEqual({ effect });
    }
  });
  test("computer and scripting belong to the desktop, not the engine", () => {
    const rules: AgentPermissionRule[] = [{ ...outside, action: "computer" }, { ...outside, action: "script" }];
    expect(agentPermissionEngineV2Rules(rules)).toEqual([]);
    expect(agentPermissionEngineV2Decision(rules, "computer", ["*"], "allow")).toEqual({ effect: "allow" });
    expect(agentPermissionEngineV2Decision(rules, "script", ["*"], "allow")).toEqual({ effect: "allow" });
  });
});

test("desktop host rule filtering preserves ordered computer and script rules only", () => {
  const computer: AgentPermissionRule = { ...outside, action: "computer", effect: "ask" };
  const script: AgentPermissionRule = { ...outside, action: "script" };
  const website: AgentPermissionRule = { ...outside, action: "webfetch" };
  const rules = [outside, computer, website, script];
  expect(agentPermissionRulesForActions(rules, ["computer", "script"])).toEqual([computer, script]);
  expect(agentPermissionRulesForActions(rules, ["webfetch"])).toEqual([website]);
  expect(agentPermissionRulesForActions([], ["computer", "script"])).toEqual([]);
  expect(rules).toEqual([outside, computer, website, script]);
});
