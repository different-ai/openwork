import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appSource, appTitle, field, generatedMcpApps, launchInput, payload, procedureTitle, record, rows } from "../worlds/generated-mcp-apps.ts";

const test = spec.world(generatedMcpApps, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 600_000,
});

test("an owner creates an independent App and a shared viewer uses it in a standard host without gaining source or write access", async ({ world, user, probe, step, evidence }) => {
  const clientCalls = () => world.requests.filter(request => request.via === "client" && request.method === "tools/call");
  const dataCalls = () => clientCalls().filter(request => request.params.name !== world.created.toolName);
  const workflows = async () => {
    const response = await probe.api(world.den.admin, "/v1/workflows");
    expect(response.response.status).toBe(200);
    return rows(record(response.body).items);
  };
  const noAccess = async (persona: "member" | "outsider", resourceUri: string) => {
    const launch = await world.call(persona, world.created.toolName, {});
    expect(launch.isError === true || Boolean(launch.rpcError)).toBe(true);
    const resource = await world.rpc(persona, "resources/read", { uri: resourceUri });
    expect(resource.rpcError).toMatchObject({ code: -32600, data: { error: "mcp_app_not_found" } });
    const source = await world.call(persona, "read_app", { appId: world.created.appId });
    expect(source.isError).toBe(true);
    for (const denied of [launch, resource, source]) {
      expect(JSON.stringify(denied)).not.toContain(appTitle);
      expect(JSON.stringify(denied)).not.toContain("reactSource");
      expect(denied).not.toHaveProperty("contents");
      expect(denied).not.toHaveProperty("structuredContent");
    }
    const search = payload(await world.call(persona, "search_capabilities", { query: appTitle, type: "mcp" }));
    expect(rows(search.matches).some(match => match.name === world.created.toolName)).toBe(false);
  };
  const open = async (persona: "owner" | "member" | "blocked") => {
    await user.navigate(world.url(persona));
    await user.see({ text: /^Ready$/ }, { timeoutMs: 60_000 });
    expect((await probe.dom("iframe")).elements).toHaveLength(0);
    await user.type({ label: "Launch arguments" }, JSON.stringify({ input: launchInput }), { replace: true });
    await user.click({ role: "button", label: "Open app" });
    await user.see({ text: "App connected" }, { timeoutMs: 60_000 });
    return world.frame();
  };

  await step("before: a teammate cannot discover or open the creator’s private App", async () => {
    await user.navigate(world.url("member"));
    await user.see({ text: "App unavailable" }, { timeoutMs: 60_000 });
    expect((await probe.dom("#open:disabled")).elements).toHaveLength(1);
    expect((await probe.dom("iframe")).elements).toHaveLength(0);
    expect(world.workflowsBefore).toEqual([]);
    expect(await workflows()).toEqual([]);
    await noAccess("member", world.created.resourceUri);
    await user.screenshot();
    evidence.recordAssertionEvidence("The new App is private and has no Workflow prerequisite", "Zero Workflows before and after create_app; the teammate cannot discover the launch tool, read its exact resource, launch by name, or read source.", true);
  });

  const originalResource = await step("after: the creator opens a ready App before any procedure exists", async () => {
    await using frame = await open("owner");
    const appUser = user.on(frame);
    await appUser.see({ role: "heading", label: appTitle });
    await appUser.see({ text: "Ready — revision one" });
    await appUser.see({ testId: "launch-input" }, { text: JSON.stringify(launchInput) });
    await appUser.see({ testId: "launch-result" }, { text: appTitle });
    await appUser.see({ text: "Theme: light" });
    expect((await probe.on(frame).dom("form")).elements).toHaveLength(0);
    const listed = rows(world.requests.find(request => request.via === "client" && request.persona === "owner" && request.method === "tools/list")?.result.tools);
    expect(listed.filter(tool => tool.name === world.created.toolName)).toHaveLength(1);
    expect(listed.find(tool => tool.name === world.created.toolName)).toMatchObject({
      annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: world.created.resourceUri, visibility: ["model", "app"] } },
    });
    for (const name of ["create_app", "update_app", "read_app"]) expect(listed.find(tool => tool.name === name)).not.toHaveProperty("_meta.ui.resourceUri");
    expect(listed.some(tool => ["open_workflows", "run_workflow_readonly"].includes(field(tool, "name")))).toBe(false);
    expect(world.created.toolName).toBe(`open_app_${world.created.appId}`);
    expect(world.created.resourceUri).toBe(`ui://openwork/apps/${world.created.appId}/revisions/${world.created.revisionId}/index.html`);
    const resource = world.requests.find(request => request.via === "client" && request.method === "resources/read");
    expect(resource?.result.contents).toMatchObject([{ uri: world.created.resourceUri, mimeType: "text/html;profile=mcp-app", _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } } } }]);
    expect((await world.hostState()).digest).toBe(resource?.resourceDigest);
    expect(resource?.resourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(dataCalls()).toEqual([]);
    expect(await workflows()).toEqual([]);
    const raw = await world.rpc("owner", "resources/read", { uri: world.created.resourceUri });
    const html = field(rows(raw.contents)[0], "text");
    expect(html).toContain("ui/notifications/size-changed");
    const legacy = await world.call("owner", "save_artifact_view", { configObjectId: world.created.appId, title: appTitle, reactSource: appSource("revision one").reactSource });
    expect(legacy.isError).toBe(true);
    expect(payload(legacy).error).toBe("deprecated_creation");
    await user.screenshot();
    evidence.recordAssertionEvidence("Standard discovery serves the real compiled App", "The official AppBridge renders the SHA-256-matched Den HTML, launch input, launch result and host theme; zero data calls and zero Workflows. Enabled legacy creation returns deprecated_creation.", true);
    return html;
  });

  const revised = await step("the owner publishes a new revision without replacing the App or losing the old one", async () => {
    const { current, updated } = await world.update();
    expect(current.reactSource).toBe(appSource("revision one").reactSource);
    expect(updated).toMatchObject({ appId: world.created.appId, pluginId: world.created.pluginId, toolName: world.created.toolName });
    expect(updated.revisionId).not.toBe(world.created.revisionId);
    expect(updated.resourceUri).not.toBe(world.created.resourceUri);
    const stale = await world.call("owner", "update_app", { ...appSource("stale revision"), appId: updated.appId, expectedRevisionId: world.created.revisionId });
    expect(stale.isError).toBe(true);
    expect(payload(stale).error).toBe("mcp_app_revision_conflict");
    const broken = await world.call("owner", "update_app", { ...appSource("broken revision"), reactSource: "export default function Broken( {", appId: updated.appId, expectedRevisionId: updated.revisionId });
    expect(broken.isError).toBe(true);
    expect(payload(broken).error).toBe("mcp_app_compile_failed");
    const latest = payload(await world.call("owner", "read_app", { appId: updated.appId }));
    expect(latest.app).toMatchObject(updated);
    expect(latest.reactSource).toBe(appSource("revision two").reactSource);
    expect(field(rows((await world.rpc("owner", "resources/read", { uri: world.created.resourceUri })).contents)[0], "text")).toBe(originalResource);
    const memberships = await probe.api(world.den.admin, `/v1/plugins/${updated.pluginId}/resolved`);
    expect(memberships.response.status).toBe(200);
    expect(rows(record(memberships.body).items)).toMatchObject([{ configObject: { id: updated.appId, objectType: "app" } }]);
    expect(rows(record(memberships.body).items)).toHaveLength(1);
    const plugins = await probe.api(world.den.admin, "/v1/plugins");
    expect(plugins.response.status).toBe(200);
    expect(rows(record(plugins.body).items).filter(plugin => plugin.name === appTitle)).toHaveLength(1);
    expect(await workflows()).toEqual([]);
    await using frame = await open("owner");
    await user.on(frame).see({ text: "Ready — revision two" });
    expect((await world.hostState()).uri).toBe(updated.resourceUri);
    await user.screenshot();
    evidence.recordAssertionEvidence("One App keeps two immutable successful revisions", "Same App, Plugin and launch name; old resource bytes remain identical. Stale updates and failed compilation leave the latest successful revision intact, with one Plugin App and no Workflow.", true);
    return updated;
  });

  await step("after: automatic sizing grows the frame and an explicit tall request respects the host’s limit", async () => {
    await using frame = await open("owner");
    const appUser = user.on(frame);
    await appUser.see({ text: "Ready — revision two" });
    const initial = await probe.eventually(async () => {
      const state = await world.hostState();
      const sizes = rows(JSON.parse(state.sizeEvents));
      const height = (await probe.dom("iframe")).elements[0]?.rect.height ?? 0;
      return { sizes, height };
    }, { until: value => value.sizes.length > 0 && value.height > 160 && value.height < 520 && value.height === value.sizes.at(-1)?.applied, within: 20_000 });
    await appUser.click({ text: "View options" });
    await appUser.click({ role: "button", label: "Expand content" });
    const expanded = await probe.eventually(async () => ({
      sizes: rows(JSON.parse((await world.hostState()).sizeEvents)), height: (await probe.dom("iframe")).elements[0]?.rect.height ?? 0,
    }), { until: value => value.sizes.some(size => Number(size.height) >= 520) && value.height >= 520 && value.height < 720, within: 20_000 });
    expect(expanded.height).toBeGreaterThan(initial.height);
    expect(expanded.height).toBe(expanded.sizes.at(-1)?.applied);
    await appUser.click({ role: "button", label: "Request height" });
    const tall = await probe.eventually(async () => ({
      sizes: rows(JSON.parse((await world.hostState()).sizeEvents)), height: (await probe.dom("iframe")).elements[0]?.rect.height ?? 0,
    }), { until: value => value.sizes.some(size => size.height === 1200 && size.applied === 720) && value.sizes.some(size => Number(size.height) >= 900 && size.height !== 1200) && value.height === 720, within: 20_000 });
    expect(tall.height).toBeLessThanOrEqual(720);
    expect(tall.height).toBeGreaterThan(expanded.height);
    expect((await probe.on(frame).dom("main")).elements[0].rect.height).toBeGreaterThanOrEqual(900);
    for (const size of tall.sizes) {
      expect(Array.isArray(size.keys)).toBe(true);
      for (const key of Array.isArray(size.keys) ? size.keys : []) expect(["height", "width"]).toContain(key);
    }
    expect(tall.sizes.find(size => size.height === 1200)?.keys).toEqual(["height"]);
    expect(await world.clicks(frame)).toEqual({ trusted: 2, untrusted: 0 });
    expect((await world.hostState()).url).toBe(world.url("owner"));
    expect(dataCalls()).toEqual([]);
    await user.see({ text: /frame 720 px; bounds 160–720 px/ });
    await user.screenshot();
    evidence.recordAssertionEvidence("Standard size notifications control the measured iframe height", `Automatic content sizing grew ${initial.height} → ${expanded.height} px; sendSizeChanged requested 1200 px and the host clamped to measured ${tall.height} px. Expanded content stays at least 900 px; ${tall.sizes.length} size notifications carried only width/height; two trusted clicks.`, true);
  });

  const procedure = await step("a Plugin viewer opens the same App and discovers an optional procedure", async () => {
    const procedure = await world.seedProcedure();
    expect(procedure.pluginId).not.toBe(revised.pluginId);
    await world.shareApp();
    const current = payload(await world.call("owner", "read_app", { appId: revised.appId }));
    expect(current.app).toMatchObject(revised);
    await using frame = await open("member");
    const appUser = user.on(frame);
    await appUser.see({ text: "Ready — revision two" });
    expect((await world.hostState()).uri).toBe(revised.resourceUri);
    expect(dataCalls()).toEqual([]);
    await appUser.click({ role: "button", label: "Find capabilities" });
    await appUser.see({ text: "1 capability found" }, { timeoutMs: 60_000 });
    const search = dataCalls().at(-1);
    expect(search).toMatchObject({ persona: "member", params: { name: "search_capabilities", arguments: { query: procedureTitle, type: "marketplace" } } });
    const matches = rows(payload(record(search?.result)).matches);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ name: `plugin:${procedure.pluginId}:${procedure.configObjectId}`, kind: "workflow", hasBody: true, pathParams: [], queryParams: [] });
    expect(clientCalls().filter(request => request.params.name === "execute_capability")).toHaveLength(0);
    const hidden = await world.call("member", "read_app", { appId: revised.appId });
    expect(hidden.isError).toBe(true);
    expect(JSON.stringify(hidden)).not.toContain("reactSource");
    expect(hidden).not.toHaveProperty("structuredContent");
    await user.screenshot();
    evidence.recordAssertionEvidence("Plugin sharing enables the same App, not its source", "The read-scoped viewer renders the unchanged App revision and discovers one separately shared pure-compute Workflow through search_capabilities. Opening runs nothing; read_app still denies source.", true);
    return procedure;
  });

  await step("after: the viewer runs a normal capability while their read-only token still rejects writes", async () => {
    await using frame = await open("member");
    const appUser = user.on(frame);
    await appUser.see({ text: "Ready — revision two" });
    await appUser.click({ role: "button", label: "Find capabilities" });
    await appUser.see({ text: "1 capability found" }, { timeoutMs: 60_000 });
    await appUser.click({ role: "button", label: "Run procedure" });
    await appUser.see({ testId: "procedure-result" }, { text: '{"total":42}', timeoutMs: 90_000 });
    const executions = clientCalls().filter(request => request.params.name === "execute_capability");
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ persona: "member", params: { arguments: { name: `plugin:${procedure.pluginId}:${procedure.configObjectId}`, body: launchInput } } });
    const result = payload(executions[0].result);
    expect(result).toMatchObject({ status: "executed", value: { total: 42 }, toolCalls: [] });
    const listedExecute = rows(world.requests.find(request => request.via === "client" && request.persona === "member" && request.method === "tools/list")?.result.tools).find(tool => tool.name === "execute_capability");
    expect(listedExecute).toMatchObject({ annotations: { destructiveHint: true } });
    const snapshots = await probe.api(world.member, `/v1/workflows/${procedure.configObjectId}/snapshots`);
    expect(snapshots.response.status).toBe(200);
    expect(rows(record(snapshots.body).items)).toHaveLength(1);
    expect(rows(record(snapshots.body).items)[0]).toMatchObject({ receiptId: field(result, "receiptId"), status: "succeeded", value: result.value, toolCalls: [] });
    await appUser.click({ text: "View options" });
    await appUser.click({ role: "button", label: "Check write access" });
    await appUser.see({ testId: "write-result" }, { text: /insufficient_mcp_scope/, timeoutMs: 30_000 });
    const write = clientCalls().filter(request => request.params.name === "create_app");
    expect(write).toHaveLength(1);
    expect(write[0].persona).toBe("member");
    expect(write[0].result.isError).toBe(true);
    expect(payload(write[0].result)).toMatchObject({ error: "insufficient_mcp_scope", message: expect.stringContaining("mcp:write") });
    const plugins = await probe.api(world.den.admin, "/v1/plugins");
    expect(rows(record(plugins.body).items).some(plugin => plugin.name === "Read scope must not create this")).toBe(false);
    expect(payload(await world.call("owner", "read_app", { appId: revised.appId })).app).toMatchObject(revised);
    expect(await world.clicks(frame)).toEqual({ trusted: 3, untrusted: 0 });
    expect((await world.hostState()).url).toBe(world.url("member"));
    await user.screenshot();
    evidence.recordAssertionEvidence("The standard tool bridge keeps caller identity and MCP scopes", "One execute_capability call (advertised destructiveHint: true; this plain reference host forwards it without a consent step) returns the real value 42 and one viewer-owned snapshot with zero provider calls. A trusted create_app attempt returns insufficient_mcp_scope; no new Plugin is created.", true);
  });

  await step("a host without server tools shows blocked actions instead of silently trying them", async () => {
    const before = dataCalls().length;
    await using frame = await open("blocked");
    await user.on(frame).see({ text: "Server tools unavailable. Reopen in a host that enables server tools." });
    expect((await probe.on(frame).dom("button:disabled")).elements).toHaveLength(3);
    expect(dataCalls()).toHaveLength(before);
    await user.screenshot();
    evidence.recordAssertionEvidence("Host capabilities control the blocked state", "getHostCapabilities reports no serverTools; discovery, execution and write controls remain disabled and send zero data calls.", true);
  });

  await step("the shared Plugin lists one App while an outsider still cannot open either revision", async () => {
    const pluginUser = user.on(world.pluginWeb);
    await pluginUser.navigate(`${world.den.ref.webUrl}/dashboard/library/plugins/${revised.pluginId}`);
    await pluginUser.see({ testId: "plugin-page" }, { timeoutMs: 120_000 });
    await pluginUser.see({ role: "heading", label: appTitle });
    await pluginUser.see({ testId: "whats-inside" }, { text: /1 thing/ });
    await pluginUser.see({ testId: "whats-inside" }, { text: new RegExp(appTitle) });
    expect((await probe.on(world.pluginWeb).dom('[data-testid="whats-inside"]')).elements[0].text).toMatch(/App/);
    await pluginUser.screenshot();
    await user.navigate(world.url("outsider"));
    await user.see({ text: "App unavailable" }, { timeoutMs: 60_000 });
    expect((await probe.dom("#open:disabled")).elements).toHaveLength(1);
    expect((await probe.dom("iframe")).elements).toHaveLength(0);
    await noAccess("outsider", revised.resourceUri);
    expect((await world.rpc("outsider", "resources/read", { uri: world.created.resourceUri })).rpcError).toMatchObject({ data: { error: "mcp_app_not_found" } });
    const outsiderSnapshots = await probe.api(world.outsider, `/v1/workflows/${procedure.configObjectId}/snapshots`);
    expect(outsiderSnapshots.response.status).toBe(403);
    expect(world.requests.filter(request => request.via === "client").every(request => ["tools/list", "resources/read", "tools/call"].includes(request.method))).toBe(true);
    expect(clientCalls().every(request => [world.created.toolName, "search_capabilities", "execute_capability", "create_app"].includes(field(request.params, "name")))).toBe(true);
    await user.screenshot();
    evidence.recordAssertionEvidence("The existing Plugin grants the App only to its viewer", "Den’s shared Plugin detail shows one titled App. The outsider cannot discover, launch, read source, read either immutable resource, or read the viewer’s procedure snapshot. The reference host used only standard MCP methods.", true);
  });
});
