import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appSource, appTitle, chatPrompt, chatReply, launchInput, mcpAppServers, mcpAppServersChat, payload, record, rows, toolNames } from "../worlds/mcp-app-servers.ts";

const test = spec.world(mcpAppServers, {
  resources: { surfaces: ["web"], services: ["den", "mock"] },
  timeout: 600_000,
});

const chatTest = spec.world(mcpAppServersChat, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { commands: ["bun", "pnpm", "opencode"] }, timeout: 600_000,
});

const composedTools = ["open_app", toolNames.live, toolNames.connection, toolNames.workflow];

test("an owner composes an App that is its own MCP server, and a teammate uses it from a standard host once its Plugin is shared", async ({ world, user, probe, step, evidence }) => {
  const appName = `plugin:${world.created.pluginId}:${world.created.appId}`;
  const clientCalls = (persona: "owner" | "member") => world.requests.filter(request => request.via === "client" && request.persona === persona && request.method === "tools/call");
  const open = async (persona: "owner" | "member") => {
    await user.navigate(world.url(persona));
    await user.see({ text: /^Ready$/ }, { timeoutMs: 60_000 });
    await user.type({ label: "Launch arguments" }, JSON.stringify({ input: launchInput }), { replace: true });
    await user.click({ role: "button", label: "Open app" });
    await user.see({ text: "App connected" }, { timeoutMs: 60_000 });
    return world.frame();
  };
  const priceOrder = async (persona: "owner" | "member", revision: string) => {
    await using frame = await open(persona);
    const appUser = user.on(frame);
    await appUser.see({ role: "heading", label: appTitle });
    await appUser.see({ text: `Ready — ${revision}` });
    await appUser.see({ testId: "pricing-date" }, { text: /^Prices as of \d{4}-\d{2}-\d{2}$/, timeoutMs: 90_000 });
    await appUser.see({ testId: "order-line" }, { text: / at 7$/, timeoutMs: 90_000 });
    await appUser.click({ role: "button", label: "Calculate total" });
    await appUser.see({ testId: "total" }, { text: "42", timeoutMs: 90_000 });
  };
  const refused = async (persona: "member" | "outsider", resourceUri: string) => {
    expect((await world.rpc(persona, "app", "tools/list", {})).rpcError).toMatchObject({ code: -32600, data: { error: "mcp_app_not_found" } });
    expect((await world.rpc(persona, "app", "tools/call", { name: toolNames.workflow, arguments: { quantity: 1, unitPrice: 1 } })).rpcError).toMatchObject({ data: { error: "mcp_app_not_found" } });
    expect((await world.rpc(persona, "app", "resources/read", { uri: resourceUri })).rpcError).toMatchObject({ data: { error: "mcp_app_not_found" } });
    expect((await world.index(persona)).some(server => server.connectionId === world.created.appId)).toBe(false);
  };

  await step("before: the App's own MCP server refuses a teammate its Plugin is not shared with", async () => {
    await refused("member", world.created.resourceUri);
    await user.navigate(world.url("member"));
    await user.see({ text: "The App is not available." }, { timeoutMs: 60_000 });
    expect((await probe.dom("iframe")).elements).toHaveLength(0);
    await user.screenshot();
    evidence.recordAssertionEvidence("The App is private to its creator", "The teammate's standard host gets a JSON-RPC mcp_app_not_found error for tools/list, tools/call, and resources/read on the App's MCP URL, and their Connect server index does not list it.", true);
  });

  await step("after: the owner opens the App from its own MCP URL, which composes a live Workflow, a connection tool, and a Workflow", async () => {
    expect(world.created.mcpUrl.endsWith(`/mcp/agent/connections/${world.created.appId}`)).toBe(true);
    const listed = rows((await world.rpc("owner", "app", "tools/list", {})).tools);
    expect(listed.map(tool => tool.name)).toEqual(composedTools);
    const byName = Object.fromEntries(listed.map(tool => [tool.name, tool]));
    expect(byName.open_app).toMatchObject({ annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: world.created.resourceUri, visibility: ["model", "app"] } } });
    expect(byName[toolNames.live]).toMatchObject({ annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object", properties: { timeZone: { type: "string" } } } });
    expect(byName[toolNames.connection]).toMatchObject({ annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object", required: ["sku"] } });
    expect(byName[toolNames.workflow]).toMatchObject({ annotations: { readOnlyHint: false }, inputSchema: { type: "object", required: ["quantity", "unitPrice"] } });
    const sinceIso = new Date().toISOString();
    await priceOrder("owner", "revision one");
    expect(clientCalls("owner").map(request => request.params.name)).toEqual(composedTools);
    const [, onOpen, lookup, total] = clientCalls("owner");
    expect(onOpen?.params.arguments).toEqual({ timeZone: "UTC" });
    expect(payload(onOpen?.result ?? {})).toMatchObject({ status: "executed" });
    expect(lookup?.params.arguments).toEqual({ sku: launchInput.sku });
    expect(total?.params.arguments).toEqual({ quantity: launchInput.quantity, unitPrice: 7 });
    expect(payload(total?.result ?? {})).toMatchObject({ status: "executed", value: { total: 42 } });
    expect((await world.inventoryCalls({ sinceIso, atLeast: 1 })).map(call => call.args)).toEqual([{ sku: launchInput.sku }]);
    expect(world.requests.filter(request => request.via === "client").every(request => request.endpoint === "app")).toBe(true);
    expect((await world.hostState()).uri).toBe(world.created.resourceUri);
    await user.screenshot();
    evidence.recordAssertionEvidence("One App composes three kinds of capability under clear tool names", `The reference host used only ${world.created.serverPath}. Its tools/list is exactly open_app, ${toolNames.live} (live Workflow, read-only), ${toolNames.connection} (Inventory connection tool, read-only per its provider), and ${toolNames.workflow} (Workflow with input, not read-only). On open the App loaded the pricing date and the unit price with its two read-only tools (the Inventory MCP recorded one real lookup); its button made the one write, and the Workflow returned 42.`, true);
  });

  await step("the owner's OpenWork Connect lists the App as its own server, opens it by launch reference, and refuses unusable tools", async () => {
    const index = await world.index("owner");
    expect(index.filter(server => server.connectionId === world.created.appId)).toEqual([{
      connectionId: world.created.appId, name: appTitle, description: null, url: world.created.mcpUrl, exposeDirectly: true,
    }]);
    const search = payload(await world.call("owner", "search_capabilities", { query: appTitle, type: "marketplace" }));
    expect(rows(search.matches).find(match => match.name === appName)).toMatchObject({ kind: "mcp_app", mcpApp: { resourceUri: world.created.resourceUri } });
    const opened = await world.call("owner", "execute_capability", { name: appName });
    expect(opened._meta).toEqual({ "openwork/mcpApp": { connectionId: world.created.appId, toolName: "open_app", resourceUri: world.created.resourceUri, arguments: { input: {} } } });
    const broken = await world.call("owner", "create_app", {
      ...appSource("never published"), title: "Unusable tools",
      tools: [{ name: "missing_tool", description: "A tool with no capability behind it.", capability: "mcp:not-a-connection:missing" }],
    });
    expect(broken.isError).toBe(true);
    expect(payload(broken)).toMatchObject({ error: "mcp_app_tool_unavailable", message: expect.stringContaining("missing_tool") });
    expect((await world.index("owner")).some(server => server.name === "Unusable tools")).toBe(false);
    evidence.recordAssertionEvidence("OpenWork registers and opens the App like a directly exposed connection", "The Connect server index lists the App at its MCP URL with exposeDirectly, executing its search match returns an openwork/mcpApp launch reference to open_app on that server, and create_app refuses a tool that is not a real capability without publishing anything.", true);
  });

  await step("Workflow-bound views from before are read-only beside App servers", async () => {
    const { tools, save } = await world.legacyWrites();
    for (const result of tools) {
      expect(result).toMatchObject({ isError: true, body: { error: "legacy_view_read_only", message: expect.stringContaining("create_app") } });
    }
    expect(save).toMatchObject({ status: 409, body: { error: "legacy_view_read_only" } });
    const connectTools = rows((await world.rpc("owner", "connect", "tools/list", {})).tools);
    expect(connectTools.find(tool => tool.name === "save_artifact_view")).toMatchObject({ title: "Legacy Artifact views are read-only" });
    expect(connectTools.map(tool => tool.name)).toEqual(expect.arrayContaining(["create_app", "update_app", "read_app"]));
    evidence.recordAssertionEvidence("Older Workflow-bound views cannot be created, edited, or re-activated", "save_artifact_view (create and edit) and activate_artifact_view_revision return legacy_view_read_only pointing to create_app, and the REST save route answers 409 legacy_view_read_only; Connect advertises create_app, update_app, and read_app.", true);
  });

  await step("after: sharing the Plugin lets the teammate use the same App URL, tools, and connection as themselves", async () => {
    await world.share();
    expect((await world.index("member")).some(server => server.connectionId === world.created.appId && server.url === world.created.mcpUrl)).toBe(true);
    const sinceIso = new Date().toISOString();
    await priceOrder("member", "revision one");
    expect(clientCalls("member").map(request => request.params.name)).toEqual(composedTools);
    expect(payload(clientCalls("member")[3]?.result ?? {})).toMatchObject({ status: "executed", value: { total: 42 } });
    expect((await world.inventoryCalls({ sinceIso, atLeast: 1 })).map(call => call.args)).toEqual([{ sku: launchInput.sku }]);
    const pluginUser = user.on(world.pluginWeb);
    await pluginUser.navigate(`${world.den.ref.webUrl}/dashboard/library/plugins/${world.created.pluginId}`);
    await pluginUser.see({ testId: "plugin-page" }, { timeoutMs: 120_000 });
    await pluginUser.see({ role: "heading", label: appTitle });
    await pluginUser.see({ testId: "whats-inside" }, { text: new RegExp(appTitle) });
    await pluginUser.see({ testId: "app-mcp-servers" }, { text: new RegExp(`Use in another app\\s+${appTitle} MCP URL`) });
    await pluginUser.screenshot();
    evidence.recordAssertionEvidence("Plugin sharing shares the App server, not credentials", "After the Plugin and its Workflows are shared, the teammate's index lists the same MCP URL, their own calls run the same three tools (one real Inventory lookup, total 42), and the Plugin page offers the App's MCP URL for other MCP clients.", true);
  });

  await step("an update keeps the same MCP URL and tools while an outsider still cannot use either revision", async () => {
    const { updated } = await world.update();
    expect(updated.serverPath).toBe(world.created.serverPath);
    expect(updated.revisionId).not.toBe(world.created.revisionId);
    const listed = rows((await world.rpc("owner", "app", "tools/list", {})).tools);
    expect(listed.map(tool => tool.name)).toEqual(composedTools);
    expect(listed[0]).toMatchObject({ _meta: { ui: { resourceUri: updated.resourceUri } } });
    expect(rows((await world.rpc("owner", "app", "resources/read", { uri: world.created.resourceUri })).contents)[0]).toMatchObject({ uri: world.created.resourceUri });
    expect(record((await world.rpc("owner", "app", "tools/call", { name: "open_app", arguments: {} })).structuredContent).app).toMatchObject({ revisionId: updated.revisionId });
    for (const resourceUri of [world.created.resourceUri, updated.resourceUri]) await refused("outsider", resourceUri);
    await user.navigate(world.url("outsider"));
    await user.see({ text: "The App is not available." }, { timeoutMs: 60_000 });
    expect((await probe.dom("iframe")).elements).toHaveLength(0);
    await user.screenshot();
    evidence.recordAssertionEvidence("Revisions stay behind the same MCP URL, tools, and access", "update_app without tools published a new revision on the same App server with the same four tools; the original revision stays readable to the owner, and the ungranted teammate is refused for both.", true);
  });
});

chatTest("in an OpenWork chat, the model opens the App with launch input and the person prices the order inside the conversation", async ({ world, agent, user, evidence }) => {
  const sinceIso = new Date().toISOString();
  await agent.send(chatPrompt);
  await user.see({ text: chatReply }, { timeoutMs: 120_000 });
  const requests = (await world.den.mocks.inventory.agentRequests({ promptMarker: chatPrompt })).filter(request => request.kind === "tool" || request.kind === "final");
  expect(requests.some(request => request.advertisedToolNames?.some(name => name.endsWith("execute_capability")))).toBe(true);
  await using frame = await world.appFrame();
  const appUser = user.on(frame);
  await appUser.see({ role: "heading", label: appTitle });
  await appUser.see({ testId: "pricing-date" }, { text: /^Prices as of \d{4}-\d{2}-\d{2}$/, timeoutMs: 90_000 });
  await appUser.see({ testId: "order-line" }, { text: `${launchInput.quantity} × ${launchInput.sku} at 7`, timeoutMs: 90_000 });
  expect((await world.inventoryCalls({ sinceIso, atLeast: 1 })).map(call => call.args)).toEqual([{ sku: launchInput.sku }]);
  await user.notSee({ text: "Allow App action?" });
  await appUser.click({ role: "button", label: "Calculate total" });
  await appUser.see({ testId: "total" }, { text: "42", timeoutMs: 90_000 });
  await user.notSee({ text: "Allow App action?" });
  await user.screenshot();
  evidence.recordAssertionEvidence("The App works inside an OpenWork chat", `The model called execute_capability with the App's exact name and { sku: "${launchInput.sku}", quantity: ${launchInput.quantity} }; the conversation rendered the App from its own server with that launch input. Its read-only tools loaded the pricing date and one real Inventory lookup without a click, and one trusted click ran the Workflow that returned 42, with no extra approval prompt.`, true);
});
