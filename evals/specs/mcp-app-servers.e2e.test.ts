import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appSource, appTitle, buildPrompt, buildReply, chatPrompt, chatReply, launchInput, mcpAppServers, mcpAppServersChat, payload, pricerTitle, record, rows, toolNames } from "../worlds/mcp-app-servers.ts";

const test = spec.world(mcpAppServers, {
  resources: { surfaces: ["web"], services: ["den", "mock"] },
  timeout: 600_000,
});

const chatTest = spec.world(mcpAppServersChat, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { commands: ["bun", "pnpm", "opencode"] }, timeout: 600_000,
});

const composedTools = ["open_app", toolNames.live, toolNames.connection, toolNames.workflow];
const orderLine = `${launchInput.quantity} × ${launchInput.sku}`;

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
  const priceOrder = async (persona: "owner" | "member", revision: string, sinceIso: string) => {
    await using frame = await open(persona);
    const appUser = user.on(frame);
    await appUser.see({ role: "heading", label: appTitle });
    await appUser.see({ text: `Ready — ${revision}` });
    await appUser.see({ testId: "pricing-date" }, { text: /^Prices as of \d{4}-\d{2}-\d{2}$/, timeoutMs: 90_000 });
    // Only the live Workflow runs on open; the connection tool waits for a click.
    await appUser.see({ testId: "order-line" }, { text: orderLine });
    expect(await world.inventoryCalls({ sinceIso })).toEqual([]);
    await appUser.click({ role: "button", label: "Look up price" });
    await appUser.see({ testId: "order-line" }, { text: `${orderLine} at 7`, timeoutMs: 90_000 });
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
    // The provider calls its lookup read-only, but OpenWork cannot verify that, so it asks first.
    expect(byName[toolNames.connection]).toMatchObject({ annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: "object", required: ["sku"] } });
    expect(byName[toolNames.workflow]).toMatchObject({ annotations: { readOnlyHint: false }, inputSchema: { type: "object", required: ["quantity", "unitPrice"] } });
    const sinceIso = new Date().toISOString();
    await priceOrder("owner", "revision one", sinceIso);
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
    evidence.recordAssertionEvidence("One App composes three kinds of capability under clear tool names", `The reference host used only ${world.created.serverPath}. Its tools/list is exactly open_app, ${toolNames.live} (live Workflow, read-only), ${toolNames.connection} (Inventory connection tool, not read-only: its provider's hint is not trusted), and ${toolNames.workflow} (Workflow with input, not read-only). On open the App ran only the live Workflow for the pricing date, and the Inventory MCP recorded no lookup; Look up price made one real lookup, and Calculate total made one Workflow run that returned 42.`, true);
  });

  await step("the owner's OpenWork Connect lists the App as its own server, opens it by launch reference, and refuses unusable tools", async () => {
    const index = await world.index("owner");
    // Listed for the App host to open, never exposed to the model as a server of its own.
    expect(index.filter(server => server.connectionId === world.created.appId)).toEqual([{
      connectionId: world.created.appId, name: appTitle, description: null, url: world.created.mcpUrl, exposeDirectly: false,
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
    const writer = await world.call("owner", "create_app", {
      ...appSource("never published"), title: "Plugin sharer",
      tools: [{ name: "share_plugin", description: "Share a Plugin with a teammate.", capability: "postPluginsAccess" }],
    });
    expect(writer.isError).toBe(true);
    expect(payload(writer)).toMatchObject({ error: "mcp_app_tool_unavailable", message: expect.stringContaining("changes data") });
    expect((await world.index("owner")).some(server => ["Unusable tools", "Plugin sharer"].includes(String(server.name)))).toBe(false);
    evidence.recordAssertionEvidence("OpenWork can open the App, and its tools stay scoped to it", "The App host's Connect server index lists the App at its MCP URL without exposing it to the model directly, and executing its search match returns an openwork/mcpApp launch reference to open_app on that server. create_app refuses a tool that is not a real capability and an OpenWork action that changes data (postPluginsAccess), publishing nothing.", true);
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

  await step("after: sharing only the App's Plugin lets the teammate use the same App URL, tools, Workflows, and connection as themselves", async () => {
    // The App's Workflow tools run through its own Plugin, so no separate Workflow grant is needed.
    const read = payload(await world.call("owner", "read_app", { appId: world.created.appId }));
    const workflowTools = rows(record(read.app).tools).filter(tool => String(tool.capability).startsWith("plugin:"));
    expect(workflowTools.map(tool => tool.capability)).toEqual(workflowTools.map(tool => expect.stringMatching(new RegExp(`^plugin:${world.created.pluginId}:`))));
    expect(workflowTools).toHaveLength(2);
    await world.share();
    expect((await world.index("member")).some(server => server.connectionId === world.created.appId && server.url === world.created.mcpUrl)).toBe(true);
    const sinceIso = new Date().toISOString();
    await priceOrder("member", "revision one", sinceIso);
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
    evidence.recordAssertionEvidence("Plugin sharing shares the App server and its Workflows, not credentials", "create_app added both Workflows to the App's own Plugin, so sharing only that Plugin was enough: the teammate's index lists the same MCP URL, their own calls run the same three tools (the live Workflow on open, then one real Inventory lookup and total 42 on two clicks), and the Plugin page offers the App's MCP URL for other MCP clients.", true);
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

chatTest("an owner prompts OpenWork's chat to build an App and to open one, and both work inside the conversation", async ({ world, agent, user, step, evidence }) => {
  const modelTool = async (marker: string) => (await world.den.mocks.inventory.agentRequests({ promptMarker: marker })).find(request => request.kind === "tool");
  const lookups = async (sinceIso: string) => (await world.inventoryCalls({ sinceIso, atLeast: 1 })).map(call => call.args);
  let builtAt = "";
  let openedAt = "";

  await step("the owner asks the chat to build an App in plain words", async () => {
    builtAt = new Date().toISOString();
    await agent.send(buildPrompt);
    await user.see({ text: buildReply }, { timeoutMs: 120_000 });
    expect((await modelTool(buildPrompt))?.toolName).toMatch(/create_app$/);
    await user.screenshot();
    evidence.recordAssertionEvidence("The chat builds the App", `For "${buildPrompt}", the model called create_app with ${pricerTitle}'s source and three declared tools: ${toolNames.live}, ${toolNames.connection}, and ${toolNames.workflow}.`, true);
  });

  await step("the new App opens in the conversation and loads its pricing date without a click", async () => {
    await using frame = await world.appFrame(pricerTitle);
    const appUser = user.on(frame);
    await appUser.see({ role: "heading", label: pricerTitle });
    await appUser.see({ testId: "pricing-date" }, { text: /^Prices as of \d{4}-\d{2}-\d{2}$/, timeoutMs: 90_000 });
    await appUser.see({ testId: "order-line" }, { text: orderLine });
    await appUser.notSee({ testId: "total" });
    expect(await world.inventoryCalls({ sinceIso: builtAt })).toEqual([]);
    await user.screenshot();
    evidence.recordAssertionEvidence("A freshly built App runs only reads OpenWork verifies on open", `Right after create_app, ${pricerTitle} opened in the conversation and loaded today's date from its live Workflow without a click. Its Inventory connection tool waited: the Inventory MCP recorded no lookup, and the App shows "${orderLine}" with no price or total.`, true);
  });

  await step("each click in the new App runs exactly one tool: the lookup, then the total", async () => {
    await using frame = await world.appFrame(pricerTitle);
    const appUser = user.on(frame);
    await appUser.click({ role: "button", label: "Look up price" });
    await appUser.see({ testId: "order-line" }, { text: `${orderLine} at 7`, timeoutMs: 90_000 });
    expect(await lookups(builtAt)).toEqual([{ sku: launchInput.sku }]);
    await appUser.click({ role: "button", label: "Calculate total" });
    await appUser.see({ testId: "total" }, { text: "42", timeoutMs: 90_000 });
    await user.screenshot();
    evidence.recordAssertionEvidence("The new App's connection tool and Workflow each run on their own click", `Clicking Look up price in ${pricerTitle} made one Inventory lookup for ${launchInput.sku}, and clicking Calculate total ran its ${toolNames.workflow} Workflow, which shows 42.`, true);
  });

  await step("the owner asks the chat to open the Order calculator for an order, naming no App or connection", async () => {
    for (const id of [world.created.appId, world.created.pluginId]) expect(chatPrompt).not.toContain(id);
    openedAt = new Date().toISOString();
    await agent.send(chatPrompt);
    await user.see({ text: chatReply }, { timeoutMs: 120_000 });
    expect((await modelTool(chatPrompt))?.toolName).toMatch(/execute_capability$/);
    await user.screenshot();
    evidence.recordAssertionEvidence("The chat opens an existing App with the order", `"${chatPrompt}" carries no App, Plugin, or connection id. The model opened ${appTitle} with execute_capability and the launch input { sku: "${launchInput.sku}", quantity: ${launchInput.quantity} }.`, true);
  });

  await step("the Order calculator opens with that order and loads its pricing date without a click", async () => {
    await using frame = await world.appFrame(appTitle);
    const appUser = user.on(frame);
    await appUser.see({ role: "heading", label: appTitle });
    await appUser.see({ testId: "pricing-date" }, { text: /^Prices as of \d{4}-\d{2}-\d{2}$/, timeoutMs: 90_000 });
    await appUser.see({ testId: "order-line" }, { text: orderLine });
    await appUser.notSee({ testId: "total" });
    expect(await world.inventoryCalls({ sinceIso: openedAt })).toEqual([]);
    await user.screenshot();
    evidence.recordAssertionEvidence("Launch input from the chat reaches the App", `${appTitle} has no sample order of its own, yet it shows "${orderLine}": the order came from the chat. Its live Workflow loaded today's date without a click, and its Inventory lookup waited for one.`, true);
  });

  await step("after: one click looks up the price and one click prices the order, with no approval prompt", async () => {
    await using frame = await world.appFrame(appTitle);
    const appUser = user.on(frame);
    await appUser.click({ role: "button", label: "Look up price" });
    await appUser.see({ testId: "order-line" }, { text: `${orderLine} at 7`, timeoutMs: 90_000 });
    expect(await lookups(openedAt)).toEqual([{ sku: launchInput.sku }]);
    await appUser.click({ role: "button", label: "Calculate total" });
    await appUser.see({ testId: "total" }, { text: "42", timeoutMs: 90_000 });
    await user.notSee({ text: "Allow App action?" });
    await user.screenshot();
    evidence.recordAssertionEvidence("Each trusted click runs its one tool", `Clicking Look up price made one Inventory lookup and clicking Calculate total ran the ${toolNames.workflow} Workflow from the conversation; ${appTitle} shows 42, with no extra approval prompt.`, true);
  });
});
