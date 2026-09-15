import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startEmbeddedServer } from "./embedded.js";
import { engineV2ByConfig } from "./engine-v2-preview.js";
import { envServiceForConfig } from "./server.js";
import { CloudProviderSync } from "./cloud-provider-sync.js";
import { createNativeV2Client, nativeCatalogProviders } from "@openwork/headless-threads/v2";
import nativeRuntime from "../../coworker/native-runtime.json" with { type: "json" };
import { CLOUD_NATIVE_SKILLS_SCOPE_HEADER, cloudNativeSkillId } from "./cloud-native-skills.js";
import { isRecord } from "./connect-mcp-transport.js";
import { writeGlobalRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";

const binary = process.env.OPENWORK_TEST_NATIVE_V2_BIN;
const ownedRoot = process.env.OPENWORK_EMBEDDED_V2_TEST_ROOT;

// Executed only by embedded-v2.test.ts after HOME/XDG isolation, with an
// explicitly selected real binary. No download, real account or model call.
test.skipIf(!binary || !ownedRoot)("real v2 registration, gateway discovery and provider sync never use a v1 API", async () => {
  if (!binary || !ownedRoot) throw new Error("Native fixture requires an isolated process and binary");
  const root = await mkdtemp(join(ownedRoot, "native-"));
  const workspace = join(root, "workspace");
  const other = join(root, "other");
  await mkdir(workspace); await mkdir(other);
  const calls: Array<{ name: string; arguments: unknown }> = [];
  const enginePaths: string[] = [];
  const apiPaths: string[] = [];
  let rejectGateway = false;
  let expectedCredential = "Bearer gateway-fixture";
  let catalogName = "search_capabilities";
  const skillUri = "skill://fixture-briefing/SKILL.md";
  const skillId = cloudNativeSkillId(skillUri);
  let skillVisible = true;
  let skillBody = "---\nname: Fixture briefing\ndescription: Native briefing instructions\n---\n\nPrivate briefing revision ALPHA.\n";
  let mcpSession = 0;
  const initialized = new Set<string>();
  const skillReads: Array<{ uri: string; session: string }> = [];
  const modelRequests: string[] = [];
  let beforeInstructionWrite: (() => Promise<void>) | undefined;
  let afterPermissionCheck: (() => Promise<void>) | undefined;
  let selectedScope: string | null = null;
  let forwardedScopeHeader = false;
  const scopeOf = (entry: Record<string, unknown> | undefined) => {
    if (!isRecord(entry?.source) || typeof entry.source.scope !== "string" || !/^[0-9a-f]{64}$/.test(entry.source.scope)) throw new Error("Missing safe native skill scope");
    return entry.source.scope;
  };
  const result = { content: [{ type: "text", text: "Actual fixture result" }],
    structuredContent: { matches: [{ name: "fixture:read", kind: "mcp" }] },
    _meta: { "openwork/mcpApp": { toolName: "fixture_app", resourceUri: "ui://fixture/view", arguments: {} }, fixture: "private-ui-metadata" } };
  let origin = "";
  const provider = () => ({ id: "lpr_fixture", providerId: "openai-compatible", name: "Fixture", source: "custom", updatedAt: null,
    providerConfig: { npm: "@ai-sdk/openai-compatible", env: ["FIXTURE_PROVIDER_KEY"], options: { baseURL: origin + "/v1" } },
    apiKey: "provider-fixture-key", apiKeys: null, models: [{ id: "fixture", name: "Fixture", config: {} }] });
  const remote = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    apiPaths.push(url.pathname);
    if (url.pathname === "/v1/chat/completions") {
      modelRequests.push(await request.text());
      const choices = [{ delta: { role: "assistant", content: "Native fixture answer" }, finish_reason: null }, { delta: {}, finish_reason: "stop" }];
      return new Response(choices.map((choice) => `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/v1/llm-providers") return Response.json({ llmProviders: [provider()] });
    if (url.pathname === "/v1/llm-providers/lpr_fixture/connect") return Response.json({ llmProvider: provider() });
    if (url.pathname !== "/mcp/agent") return request.method === "GET" ? Response.json({}) : new Response(null, { status: 404 });
    if (rejectGateway || request.headers.get("authorization") !== expectedCredential) return new Response(null, { status: 401 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = await request.json();
    const session = request.headers.get("mcp-session-id") ?? "";
    if (body.method === "notifications/initialized" || !Object.hasOwn(body, "id")) {
      initialized.add(session);
      return new Response(null, { status: 202 });
    }
    let value: unknown;
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fixture", version: "1" } } },
      { headers: { "mcp-session-id": `fixture-session-${++mcpSession}` } });
    else if (body.method === "tools/list") value = { tools: [catalogName, "execute_capability"].map((name) => ({ name,
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } } },
      annotations: { readOnlyHint: true, destructiveHint: false } })) };
    else if (body.method === "resources/read") {
      const uri = body.params.uri;
      if (uri === "skill://index.json" || uri === skillUri) {
        if (!session || !initialized.has(session) || request.headers.get("mcp-protocol-version") !== "2025-06-18") return new Response(null, { status: 400 });
        skillReads.push({ uri, session });
      }
      value = { contents: [{ uri, mimeType: "text/markdown", text: uri === skillUri ? skillBody
        : uri === "skill://index.json" ? JSON.stringify({ skills: skillVisible ? [{ name: "fixture-briefing", type: "skill-md", url: skillUri }] : [] })
          : JSON.stringify({ schemaVersion: "openwork.connect/mcp-servers/1", servers: [] }) }] };
    }
    else if (body.method === "tools/call") { calls.push(body.params); value = result; }
    else value = {};
    return Response.json({ jsonrpc: "2.0", id: body.id, result: value });
  } });
  origin = `http://127.0.0.1:${remote.port}`;
  const originalFetch = globalThis.fetch;
  const observedFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("Native fixture refuses external egress");
    enginePaths.push(url.pathname);
    if (url.pathname.startsWith("/api/") && new Headers(init?.headers).has(CLOUD_NATIVE_SKILLS_SCOPE_HEADER)) forwardedScopeHeader = true;
    if (beforeInstructionWrite && init?.method === "PUT" && url.pathname.endsWith("/instructions/entries/openwork.context")) {
      const write = beforeInstructionWrite;
      beforeInstructionWrite = undefined;
      await write();
    }
    if (afterPermissionCheck && init?.method === "POST" && url.pathname.endsWith("/permission")) {
      const checked = afterPermissionCheck;
      afterPermissionCheck = undefined;
      const response = await originalFetch(input, init);
      await checked();
      return response;
    }
    return originalFetch(input, init);
  }, { preconnect: originalFetch.preconnect });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(observedFetch);
  const options = { engine: "v2" as const, opencodeV2Bin: binary, workspaces: [workspace, other], port: 0,
    token: "client-fixture", hostToken: "host-fixture", configPath: join(root, "server.json"), logRequests: false,
    approvalMode: "auto" as const, opencodeV2: { version: nativeRuntime.opencodeV2Version, rootDir: join(root, "engine"), config: { warming: false, update: "disable",
      agents: { fixture: { mode: "primary", sources: ["tools", "skills"], permissions: [
        { action: "*", resource: "*", effect: "deny" }, { action: "skill", resource: "*", effect: "allow" },
      ] }, "fixture-denied": { mode: "primary", permissions: [{ action: "*", resource: "*", effect: "deny" }] },
      "fixture-ask": { mode: "primary", permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "skill", resource: "*", effect: "ask" }] } } },
      env: { OPENCODE_MODELS_URL: origin, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
        XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state") } } };
  let handle: Awaited<ReturnType<typeof startEmbeddedServer>> | undefined;
  let sync: CloudProviderSync | undefined;
  try {
    handle = await startEmbeddedServer(options);
    const base = handle.url;
    const id = handle.config.workspaces[0]!.id;
    const otherId = handle.config.workspaces[1]!.id;
    const headers = { authorization: "Bearer client-fixture", "content-type": "application/json" };
    const post = async (path: string, body: unknown, scope: string | null = selectedScope) => {
      const bound = isRecord(body) && Array.isArray(body.skills) && body.skills.length > 0 && scope !== null;
      const response = await originalFetch(base + path, { method: "POST", headers: { ...headers, ...(bound ? { [CLOUD_NATIVE_SKILLS_SCOPE_HEADER]: scope } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      const value = await response.json();
      return { response, value };
    };
    const cloudPath = `/workspace/${id}/mcp/openwork-cloud`;
    const cloudConfig = { type: "remote", url: origin + "/mcp/agent", enabled: true, oauth: false, codemode: false,
      headers: { Authorization: expectedCredential } };
    const reconciled = await post(cloudPath + "/reconcile", { config: cloudConfig });
    expect(reconciled.response.status).toBe(200);
    expect(reconciled.value).toMatchObject({ usable: true, engine: { status: "connected" }, pluginCanaries: { expected: [] } });
    expect(reconciled.value.compatibility.opencode.actualVersion).toBe(nativeRuntime.opencodeV2Version);
    expect(reconciled.value.compatibility.opencode.expectedVersion).toBe(nativeRuntime.opencodeV2Version);
    const mount = `/workspace/${id}/opencode2/api`;
    const readSkills = async () => {
      const response = await originalFetch(base + mount + "/skill", { headers, signal: AbortSignal.timeout(15_000) });
      expect(response.status).toBe(200);
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error("Missing native skill catalog");
      return payload.data.filter(isRecord);
    };
    const beforeDiscovery = skillReads.length;
    const firstSkill = (await readSkills()).find((entry) => entry.id === skillId);
    selectedScope = scopeOf(firstSkill);
    expect(firstSkill).toMatchObject({ id: skillId, name: "Fixture briefing", content: expect.stringContaining("revision ALPHA"), source: { type: "openwork-cloud", uri: skillUri } });
    let location = String(firstSkill?.location);
    expect(location).toContain("/engine/cloud-skills/");
    expect(location).not.toContain("/workspace/");
    expect(await readFile(location, "utf8")).toBe(skillBody);
    expect((await stat(location)).mode & 0o777).toBe(0o600);
    expect(await readdir(workspace)).not.toContain(".opencode");
    const discovered = skillReads.slice(beforeDiscovery);
    expect(discovered.map((read) => read.uri)).toEqual(["skill://index.json", skillUri]);
    expect(new Set(discovered.map((read) => read.session)).size).toBe(1);
    expect(modelRequests).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect((await post(cloudPath + "/search", { query: "fixture", limit: 3 })).value).toEqual(result);
    expect(calls).toEqual([{ name: "search_capabilities", arguments: { query: "fixture", limit: 3 } }]);
    for (const body of [{ query: "fixture", name: "execute_capability" }, { query: "fixture", url: origin }, { query: "" }, { query: "x", limit: 21 }]) {
      expect((await post(cloudPath + "/search", body)).response.status).toBe(400);
    }
    expect((await post("/workspace/missing/mcp/openwork-cloud/search", { query: "x" })).response.status).toBe(404);
    await writeFile(join(other, "opencode.json"), JSON.stringify({ permissions: [{ action: "openwork-cloud_search_capabilities", resource: "*", effect: "deny" }] }));
    expect((await post(`/workspace/${otherId}/mcp/openwork-cloud/search`, { query: "x" })).value.code).toBe("tool_denied");
    expect(calls).toHaveLength(1);
    catalogName = "search_capabilities_other";
    expect((await post(cloudPath + "/search", { query: "x" })).value.code).toBe("tool_not_found");
    expect(calls).toHaveLength(1);
    catalogName = "search_capabilities";
    expectedCredential = "Bearer rotated-gateway-fixture";
    expect((await post(cloudPath + "/reconcile", { config: { ...cloudConfig, headers: { Authorization: expectedCredential } } })).value.usable).toBe(true);
    expect((await post(cloudPath + "/search", { query: "rotated" })).value).toEqual(result);
    const rotated = (await readSkills()).find((entry) => entry.id === skillId);
    expect(scopeOf(rotated)).not.toBe(selectedScope);
    selectedScope = scopeOf(rotated);
    expect(rotated?.location).not.toBe(location);
    expect(await stat(location).then(() => true, () => false)).toBe(false);
    location = String(rotated?.location);

    const stdio = join(root, "local-mcp.mjs");
    await writeFile(stdio, `import { createInterface } from "node:readline";
createInterface({input:process.stdin}).on("line", line => { const message=JSON.parse(line); if(!Object.hasOwn(message,"id"))return;
const result=message.method==="initialize"?{protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"local-fixture",version:"1"}}:message.method==="tools/list"?{tools:[]}:{};
process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result})+"\\n"); });`);
    expect((await post(`/workspace/${id}/mcp`, { name: "local-fixture", config: { type: "local", command: [process.execPath, stdio] } })).response.status).toBe(200);
    const native = engineV2ByConfig.get(handle.config)!;
    expect((await native.request(workspace, "/api/mcp")).json).toMatchObject({ data: expect.arrayContaining([{ name: "local-fixture", status: { status: "connected" } }]) });
    await originalFetch(base + `/workspace/${id}/mcp/local-fixture`, { method: "DELETE", headers });
    expect(JSON.stringify((await native.request(workspace, "/api/mcp")).json)).not.toContain("local-fixture");

    sync = new CloudProviderSync({ config: handle.config, env: envServiceForConfig(handle.config)!, reloadEngine: async () => { await native.refresh(); return { action: "reloaded_in_place" }; }, engineBusy: async () => false });
    await sync.setSession({ baseUrl: origin, token: "local-control-fixture", orgId: "fixture" });
    const synced = await sync.run("native-proof");
    expect(synced.status).toBe("applied");
    expect((await native.request(workspace, "/api/model")).json).toMatchObject({ data: expect.arrayContaining([expect.objectContaining({ providerID: "lpr_fixture", id: "fixture" })]) });
    const providerResponse = await originalFetch(base + `/workspace/${id}/opencode2/api/provider`, { headers });
    expect(providerResponse.status).toBe(200);
    const publicProviders = await providerResponse.text();
    expect(publicProviders).not.toContain("provider-fixture-key");
    expect(publicProviders).not.toContain("apiKey");
    const client = createNativeV2Client({ baseUrl: base, workspaceId: id, token: "client-fixture" });
    const catalog = await client.readCatalog();
    expect(catalog.providers.find((entry) => entry.id === "lpr_fixture")).toMatchObject({
      name: "Fixture", package: "@opencode-ai/ai/providers/openai-compatible", settings: { baseURL: origin },
    });
    expect(catalog.connectedProviderIds).toContain("lpr_fixture");
    expect(nativeCatalogProviders(catalog).find((entry) => entry.id === "lpr_fixture")).toMatchObject({
      options: { baseURL: origin }, models: { fixture: { name: "Fixture" } },
    });
    // Provider rewrites retain the private skill directory and all host config.
    const engineConfig = JSON.parse(await readFile(join(options.opencodeV2.rootDir, "config/opencode.json"), "utf8"));
    expect(engineConfig.skills).toHaveLength(1);
    expect(engineConfig.agents.fixture.sources).toEqual(["tools", "skills"]);
    expect((await readSkills()).find((entry) => entry.id === skillId)?.content).toContain("revision ALPHA");
    const sessionId = "ses_fixture_cloud_skills";
    await client.createSession({ id: sessionId, title: "Native skill lifecycle", model: { providerID: "lpr_fixture", id: "fixture" }, agent: "fixture" });
    const missingScope = await post(mount + `/session/${sessionId}/prompt`, { id: "msg_fixture_no_scope", text: "Read the briefing.", skills: [{ id: skillId }] }, null);
    expect(missingScope.response.status).toBe(400);
    expect(missingScope.value.code).toBe("cloud_skill_scope_required");
    expect(modelRequests).toHaveLength(0);
    await client.switchAgent(sessionId, "fixture-denied");
    for (const operation of ["prompt", "command", "generate"]) {
      const denied = await post(mount + `/session/${sessionId}/${operation}`, { id: `msg_fixture_denied_${operation}`, text: "Read the briefing.", skills: [{ id: skillId }] });
      expect(denied.response.status).toBe(403);
      expect(denied.value.code).toBe("skill_denied");
    }
    await client.switchAgent(sessionId, "fixture-ask");
    const asked = await post(mount + `/session/${sessionId}/prompt`, { id: "msg_fixture_asked", text: "Read the briefing.", skills: [{ id: skillId }] });
    expect(asked.response.status).toBe(403);
    expect(asked.value.code).toBe("skill_permission_required");
    const pending = await client.listPermissions(sessionId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ action: "skill", resources: [skillId] });
    const stillAsked = await post(mount + `/session/${sessionId}/prompt`, { id: "msg_fixture_still_asked", text: "Read the briefing.", skills: [{ id: skillId }] });
    expect(stillAsked.value.code).toBe("skill_permission_required");
    expect(await client.listPermissions(sessionId)).toEqual(pending);
    await client.replyPermission(pending[0]!, "reject");
    await client.switchAgent(sessionId, "fixture");
    await client.checkSkills(sessionId, [{ id: skillId }]);
    beforeInstructionWrite = () => client.switchAgent(sessionId, "fixture-denied").then(() => undefined);
    const changedPermission = await post(mount + `/session/${sessionId}/prompt`, { id: "msg_fixture_late_denied", text: "Read the briefing.", skills: [{ id: skillId }] });
    expect(changedPermission.response.status).toBe(403);
    expect(changedPermission.value.code).toBe("skill_denied");
    expect(enginePaths.some((path) => /\/(?:prompt|command|generate)$/.test(path))).toBe(false);
    expect(modelRequests).toHaveLength(0);
    const emptyInbox = await native.request(workspace, `/api/session/${sessionId}/inbox`);
    expect(emptyInbox.json).toMatchObject({ data: [] });
    await client.switchAgent(sessionId, "fixture");
    const turn = async (messageId: string, selected = true) => {
      const before = modelRequests.length;
      // Exercise this server's wire contract directly. The independently owned
      // headless client must accept source.scope before using this catalog.
      const admitted = await post(mount + `/session/${sessionId}/prompt`, { id: messageId, text: "Read the current briefing instructions.",
        ...(selected ? { skills: [{ id: skillId }] } : {}) });
      expect(admitted.response.status).toBe(200);
      const wait = await originalFetch(base + mount + `/session/${sessionId}/wait`, { method: "POST", headers, signal: AbortSignal.timeout(20_000) });
      expect(wait.status).toBe(204);
      expect(modelRequests.length).toBeGreaterThan(before);
      return modelRequests.slice(before).join("\n");
    };
    expect(await turn("msg_fixture_cloud_first")).toContain("revision ALPHA");
    skillBody = skillBody.replace("revision ALPHA", "revision BRAVO");
    expect((await readSkills()).find((entry) => entry.id === skillId)?.content).toContain("revision BRAVO");
    expect(await turn("msg_fixture_cloud_updated")).toContain("revision BRAVO");
    // A is admitted at HTTP ingress, waits in the existing host queue, then
    // B replaces the connection with the same skill ID. Never submit as B.
    let releaseQueue = () => {};
    let queueReady = () => {};
    const gate = new Promise<void>((resolve) => { releaseQueue = resolve; });
    const ready = new Promise<void>((resolve) => { queueReady = resolve; });
    const holding = native.withNativeSkills(workspace, async () => { queueReady(); await gate; });
    await Promise.race([ready, holding.then(() => { throw new Error("Admission queue did not reach its fixture gate"); })]);
    let requestQueued = () => {};
    const queued = new Promise<void>((resolve) => { requestQueued = resolve; });
    const withSkills = native.withNativeSkills;
    const queueSpy = spyOn(native, "withNativeSkills").mockImplementation((directory, use, scope) => {
      const pending = withSkills(directory, use, scope);
      requestQueued();
      return pending;
    });
    const beforeSwitch = enginePaths.filter((path) => path.endsWith("/prompt")).length;
    const accountA = selectedScope;
    const queuedPrompt = post(mount + `/session/${sessionId}/prompt`, { id: "msg_fixture_queued_a", text: "Read the briefing.", skills: [{ id: skillId }] }, accountA);
    try {
      await Promise.race([queued, queuedPrompt.then(() => { throw new Error("Expected the A-bound request to wait in the skill queue"); })]);
      expectedCredential = "Bearer account-b-fixture";
      skillBody = skillBody.replace("revision BRAVO", "revision CHARLIE account B");
      await writeGlobalRuntimeOpencodeConfig(handle.config, (current) => ({ ...current, mcp: { ...current.mcp,
        "openwork-cloud": { ...cloudConfig, headers: { Authorization: expectedCredential } },
      } }));
    } finally { queueSpy.mockRestore(); releaseQueue(); }
    await holding;
    const switched = await queuedPrompt;
    expect(switched.response.status).toBe(400);
    expect(switched.value.code).toBe("cloud_skill_scope_mismatch");
    expect(enginePaths.filter((path) => path.endsWith("/prompt"))).toHaveLength(beforeSwitch);
    const accountB = (await readSkills()).find((entry) => entry.id === skillId);
    selectedScope = scopeOf(accountB);
    expect(selectedScope).not.toBe(accountA);
    location = String(accountB?.location);
    // Revoke after selection, before admission: the host's fresh prompt read
    // rejects it even if a caller retained the earlier native catalog.
    skillVisible = false;
    const beforeRejected = enginePaths.filter((path) => path.endsWith("/prompt")).length;
    const revoked = await post(mount + `/session/${sessionId}/prompt`, { id: "msg_fixture_revoked", text: "Read the briefing.", skills: [{ id: skillId }] });
    expect(revoked.response.status).toBe(400);
    expect(revoked.value.code).toBe("skill_unavailable");
    expect(enginePaths.filter((path) => path.endsWith("/prompt"))).toHaveLength(beforeRejected);
    expect(await readSkills()).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: skillId })]));
    expect(await stat(location).then(() => true, () => false)).toBe(false);
    // A fresh headless selection fails before its permission request or prompt.
    await expect(client.admitInput(sessionId, { id: "msg_fixture_missing", type: "user", text: "Read the briefing.", skills: [{ id: skillId }] })).rejects.toMatchObject({ code: "skill_unavailable" });
    skillVisible = true;
    const restored = (await readSkills()).find((entry) => entry.id === skillId);
    expect(restored).toBeDefined();
    rejectGateway = true;
    expect((await readSkills()).some((entry) => entry.id === skillId)).toBe(false);
    expect(await stat(String(restored?.location)).then(() => true, () => false)).toBe(false);
    await expect(client.admitInput(sessionId, { id: "msg_fixture_unauthorized", type: "user", text: "Read the briefing.", skills: [{ id: skillId }] })).rejects.toMatchObject({ code: "skill_unavailable" });
    expect(enginePaths.filter((path) => path.endsWith("/prompt"))).toHaveLength(beforeRejected);
    // Ordinary chat still admits with an empty Cloud catalog after failed refresh.
    await turn("msg_fixture_without_cloud", false);
    const instructionResponse = await native.request(workspace, `/api/session/${sessionId}/instructions/entries`);
    expect(instructionResponse.status).toBe(200);
    const instructions = JSON.stringify(instructionResponse.json);
    expect(instructions).toContain("Authorized organization skills are in the native skill catalog");
    expect(instructions).not.toContain("available_remote_skills");
    expect(instructions).not.toContain("execute_capability");
    expect(calls).toHaveLength(2);
    // Sign-out after the readiness barrier but before final dispatch must
    // reject rather than replay or admit against a changing authorization.
    rejectGateway = false;
    const beforeSignout = (await readSkills()).find((entry) => entry.id === skillId);
    expect(beforeSignout).toBeDefined();
    afterPermissionCheck = async () => {
      await writeGlobalRuntimeOpencodeConfig(handle!.config, (current) => {
        const mcp = { ...current.mcp };
        delete mcp["openwork-cloud"];
        return { ...current, mcp };
      });
    };
    const promptCount = enginePaths.filter((path) => path.endsWith("/prompt")).length;
    const signedOut = await post(mount + `/session/${sessionId}/prompt`, { id: "msg_fixture_signed_out", text: "Read the briefing.", skills: [{ id: skillId }] });
    expect(signedOut.response.status).toBe(400);
    expect(signedOut.value.code).toBe("cloud_skill_scope_mismatch");
    expect(enginePaths.filter((path) => path.endsWith("/prompt"))).toHaveLength(promptCount);
    const readsBefore = skillReads.length;
    expect((await readSkills()).some((entry) => entry.id === skillId)).toBe(false);
    expect(skillReads).toHaveLength(readsBefore);
    expect(await stat(String(beforeSignout?.location)).then(() => true, () => false)).toBe(false);
    await sync.clearSession();
    expect(await readFile(join(options.opencodeV2.rootDir, "config/opencode.json"), "utf8")).not.toContain("provider-fixture-key");
    rejectGateway = true;
    expect((await post(cloudPath + "/engine-refresh", {})).value.health.usable).toBe(false);
    expect((await post(cloudPath + "/search", { query: "revoked" })).response.status).not.toBe(200);
    expect(calls).toHaveLength(2);
    expect(enginePaths).toContain("/api/plugin/await-activation");
    expect(forwardedScopeHeader).toBe(false);
    expect(enginePaths.some((path) => path === "/mcp" || path.startsWith("/mcp/openwork-cloud") || path === "/config/providers" || path === "/config/provider" || path.startsWith("/auth/"))).toBe(false);
    expect(apiPaths.filter((path) => path.includes("chat/completions") || path.includes("responses")).every((path) => path === "/v1/chat/completions")).toBe(true);
    await handle.stop();
    expect(handle.managedOpencodeV2?.isAlive()).toBe(false);

    const brokenPlugin = join(root, "broken-plugin");
    await mkdir(brokenPlugin);
    await writeFile(join(brokenPlugin, "package.json"), '{"type":"module"}');
    await writeFile(join(brokenPlugin, "server.js"), 'throw new Error("fixture plugin activation failed");');
    await expect(startEmbeddedServer({ ...options, opencodeV2: { ...options.opencodeV2,
      config: { warming: false, update: "disable", plugins: [pathToFileURL(brokenPlugin).href] } } })).rejects.toThrow("failed configured plugin");
  } finally {
    sync?.stop();
    await handle?.stop();
    fetchSpy.mockRestore();
    remote.stop(true);
  }
}, 100_000);
