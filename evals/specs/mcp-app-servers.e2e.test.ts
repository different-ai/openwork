import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appSource, appTitle, buildPrompt, buildReply, chatPrompt, chatReply, launchInput, mcpAppServers, mcpAppServersChat, payload, pricerTitle, record, reopenPrompt, reopenReply, reservationId, rows, toolNames } from "../worlds/mcp-app-servers.ts";

const test = spec.world(mcpAppServers, {
  resources: { surfaces: ["web"], services: ["den", "mock"] },
  timeout: 600_000,
});

const chatTest = spec.world(mcpAppServersChat, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { commands: ["bun", "pnpm", "opencode"] }, timeout: 600_000,
});

const composedTools = ["open_app", toolNames.live, toolNames.connection, toolNames.workflow, toolNames.reserve];
const orderLine = `${launchInput.quantity} × ${launchInput.sku}`;
const pricedLine = `${orderLine} at 7`;
const reservedLine = `Reserved ${reservationId}`;
const reservation = { sku: launchInput.sku, quantity: launchInput.quantity };

test("an owner composes an App that is its own MCP server, and a teammate uses it from a standard host once its Plugin is shared", async ({ world, user, probe, step, evidence }) => {
  const appTile = (resourceUri: string) => ({
    serverName: expect.stringMatching(/^openwork-app-host-connect-[0-9a-f]{12}$/), connectionId: world.created.appId, toolName: "open_app",
    projectedToolName: expect.stringMatching(/^openwork-app-host-connect-[0-9a-f]{12}_open_app$/), resourceUri, title: appTitle,
  });
  const appName = `plugin:${world.created.pluginId}:${world.created.appId}`;
  const clientCalls = (persona: "owner" | "member") => world.requests.filter(request => request.via === "client" && request.persona === persona && request.method === "tools/call");
  const clientToolNames = (persona: "owner" | "member") => clientCalls(persona).map(request => request.params.name);
  // open_app first, then the two reads the App makes on open in either order, then one call per click.
  const expectCalls = (persona: "owner" | "member", clicked: string[]) => {
    const names = clientToolNames(persona);
    expect(names[0]).toBe("open_app");
    expect(names.slice(1, 3).sort()).toEqual([toolNames.connection, toolNames.live].sort());
    expect(names.slice(3)).toEqual(clicked);
  };
  const clientCall = (persona: "owner" | "member", name: string) => clientCalls(persona).find(request => request.params.name === name);
  // One App frame is open at a time; it stays open across the steps that click in it.
  let frame: Awaited<ReturnType<typeof world.frame>> | undefined;
  await using _openFrame = { [Symbol.asyncDispose]: async () => { await frame?.[Symbol.asyncDispose](); } };
  const open = async (persona: "owner" | "member") => {
    await frame?.[Symbol.asyncDispose]();
    frame = undefined;
    await user.navigate(world.url(persona));
    await user.see({ text: /^Ready$/ }, { timeoutMs: 60_000 });
    await user.type({ label: "Launch arguments" }, JSON.stringify({ input: launchInput }), { replace: true });
    await user.click({ role: "button", label: "Open app" });
    await user.see({ text: "App connected" }, { timeoutMs: 60_000 });
    frame = await world.frame();
    return user.on(frame);
  };
  // Opening runs only the reads: the pricing date and the Inventory price load, and the reservation waits for a click.
  const opened = async (persona: "owner" | "member", revision: string, sinceIso: string) => {
    const appUser = await open(persona);
    await appUser.see({ role: "heading", label: appTitle });
    await appUser.see({ text: `Ready — ${revision}` });
    await appUser.see({ testId: "pricing-date" }, { text: /^Prices as of \d{4}-\d{2}-\d{2}$/, timeoutMs: 90_000 });
    await appUser.see({ testId: "order-line" }, { text: pricedLine, timeoutMs: 90_000 });
    expect((await world.inventoryCalls({ sinceIso, atLeast: 1 })).map(call => call.args)).toEqual([{ sku: launchInput.sku }]);
    expect(await world.reservations({ sinceIso })).toEqual([]);
    return appUser;
  };
  const reserve = async (appUser: Awaited<ReturnType<typeof opened>>) => {
    await appUser.click({ role: "button", label: "Reserve stock" });
    await appUser.see({ testId: "reservation" }, { text: reservedLine, timeoutMs: 90_000 });
  };
  const calculate = async (appUser: Awaited<ReturnType<typeof opened>>) => {
    await appUser.click({ role: "button", label: "Calculate total" });
    await appUser.see({ testId: "total" }, { text: "42", timeoutMs: 90_000 });
  };
  const refused = async (persona: "member" | "outsider", resourceUri: string) => {
    expect((await world.rpc(persona, "app", "tools/list", {})).rpcError).toMatchObject({ code: -32600, data: { error: "mcp_app_not_found" } });
    expect((await world.rpc(persona, "app", "tools/call", { name: toolNames.workflow, arguments: { quantity: 1, unitPrice: 1 } })).rpcError).toMatchObject({ data: { error: "mcp_app_not_found" } });
    expect((await world.rpc(persona, "app", "resources/read", { uri: resourceUri })).rpcError).toMatchObject({ data: { error: "mcp_app_not_found" } });
    expect((await world.index(persona)).some(server => server.connectionId === world.created.appId)).toBe(false);
  };
  let ownerApp: Awaited<ReturnType<typeof opened>> | undefined;
  let ownerSince = "";
  let updatedResourceUri = "";

  await step("before: an organization has no App builder until a platform admin turns it on in /admin", async () => {
    expect(world.builderToolsBefore).toEqual([]);
    const names = rows((await world.rpc("owner", "connect", "tools/list", {})).tools).map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(["create_app", "update_app", "read_app"]));
    evidence.recordAssertionEvidence("Building your own Apps is off until /admin turns it on", "Before the organization's Apps built in OpenWork capability was on, Connect offered none of create_app, update_app, or read_app. After a platform admin turned it on through the route the /admin panel uses, Connect offers all three.", true);
  });

  await step("before: a teammate the App's Plugin is not shared with is refused by its MCP server", async () => {
    await refused("member", world.created.resourceUri);
    await user.navigate(world.url("member"));
    await user.see({ testId: "viewer" }, { text: "Signed in as a teammate" });
    await user.see({ text: "The App is not available." }, { timeoutMs: 60_000 });
    expect((await probe.dom("iframe")).elements).toHaveLength(0);
    await user.screenshot();
    evidence.recordAssertionEvidence("The App is private to its creator", "The teammate's standard host gets a JSON-RPC mcp_app_not_found error for tools/list, tools/call, and resources/read on the App's MCP URL, and their Connect server index does not list it.", true);
  });

  await step("the owner opens the App from its own MCP URL, and only its reads run: the pricing date and the Inventory price load, and the reservation waits for a click", async () => {
    expect(world.created.mcpUrl.endsWith(`/mcp/agent/connections/${world.created.appId}`)).toBe(true);
    const listed = rows((await world.rpc("owner", "app", "tools/list", {})).tools);
    expect(listed.map(tool => tool.name)).toEqual(composedTools);
    const byName = Object.fromEntries(listed.map(tool => [tool.name, tool]));
    expect(byName.open_app).toMatchObject({ annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: world.created.resourceUri, visibility: ["model", "app"] } } });
    expect(byName[toolNames.live]).toMatchObject({ annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object", properties: { timeZone: { type: "string" } } } });
    // The provider marks its lookup read-only and not destructive, so the App server says so too.
    expect(byName[toolNames.connection]).toMatchObject({ annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object", required: ["sku"] } });
    expect(byName[toolNames.workflow]).toMatchObject({ annotations: { readOnlyHint: false }, inputSchema: { type: "object", required: ["quantity", "unitPrice"] } });
    // The reservation is not marked read-only, so it is not read-only here.
    expect(byName[toolNames.reserve]).toMatchObject({ annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: "object", required: ["sku", "quantity"] } });
    ownerSince = new Date().toISOString();
    ownerApp = await opened("owner", "revision one", ownerSince);
    await user.see({ testId: "viewer" }, { text: "Signed in as the owner" });
    expectCalls("owner", []);
    expect(clientCall("owner", toolNames.live)?.params.arguments).toEqual({ timeZone: "UTC" });
    expect(payload(clientCall("owner", toolNames.live)?.result ?? {})).toMatchObject({ status: "executed" });
    expect(clientCall("owner", toolNames.connection)?.params.arguments).toEqual({ sku: launchInput.sku });
    await user.screenshot();
    evidence.recordAssertionEvidence("Opening an App runs only its read-only tools", `The App's own MCP server at ${world.created.serverPath} lists exactly open_app, ${toolNames.live} (live Workflow, read-only), ${toolNames.connection} (Inventory lookup its provider marks read-only, so read-only), ${toolNames.workflow} (Workflow with input, not read-only), and ${toolNames.reserve} (Inventory reservation, not marked read-only). On open the reference host called open_app, ${toolNames.live}, and ${toolNames.connection}: the Inventory MCP recorded one lookup and no reservation, and the order line reads "${pricedLine}".`, true);
  });

  await step("one click on Reserve stock makes exactly one reservation", async () => {
    if (!ownerApp) throw new Error("The owner's App is not open");
    await reserve(ownerApp);
    expectCalls("owner", [toolNames.reserve]);
    expect(clientCall("owner", toolNames.reserve)?.params.arguments).toEqual(reservation);
    expect((await world.reservations({ sinceIso: ownerSince, atLeast: 1 })).map(call => call.args)).toEqual([reservation]);
    expect(await world.inventoryCalls({ sinceIso: ownerSince })).toHaveLength(1);
    await user.screenshot();
    evidence.recordAssertionEvidence("A connection tool that is not read-only runs on a click, once", `Clicking Reserve stock made one ${toolNames.reserve} call, and the Inventory MCP recorded exactly one reservation of ${launchInput.quantity} × ${launchInput.sku}. The App shows "${reservedLine}".`, true);
  });

  await step("after: one click on Calculate total runs the pricing Workflow, and the owner sees 42", async () => {
    if (!ownerApp) throw new Error("The owner's App is not open");
    await calculate(ownerApp);
    expectCalls("owner", [toolNames.reserve, toolNames.workflow]);
    const total = clientCall("owner", toolNames.workflow);
    expect(total?.params.arguments).toEqual({ quantity: launchInput.quantity, unitPrice: 7 });
    expect(payload(total?.result ?? {})).toMatchObject({ status: "executed", value: { total: 42 } });
    expect(world.requests.filter(request => request.via === "client").every(request => request.endpoint === "app")).toBe(true);
    expect((await world.hostState()).uri).toBe(world.created.resourceUri);
    await user.screenshot();
    evidence.recordAssertionEvidence("The App's button runs its Workflow as the owner", `Clicking Calculate total made one ${toolNames.workflow} call with { quantity: ${launchInput.quantity}, unitPrice: 7 }, and the Workflow returned 42. Every request from the reference host went to the App's own MCP URL, never to OpenWork Connect.`, true);
  });

  await step("the owner's OpenWork Connect lists the App for its App host, opens it by launch reference, and refuses tools an App may not bind", async () => {
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

  const adminUser = user.on(world.adminWeb);
  await step("Den's dashboard Add app picker lists the App under Apps built in OpenWork", async () => {
    await adminUser.see({ text: world.dashboardName }, { timeoutMs: 120_000 });
    await adminUser.click("Add app");
    await adminUser.see({ text: "Apps built in OpenWork" }, { timeoutMs: 60_000 });
    await adminUser.see({ testId: "built-app-sharing-note" }, { text: "Members see an App only when its Plugin is shared with them." });
    await adminUser.see({ text: appTitle });
    await adminUser.screenshot();
    evidence.recordAssertionEvidence("Apps built in OpenWork appear in dashboard assignment", `The owner's Add app picker offers "Apps built in OpenWork" first, lists ${appTitle}, and notes that members need the App's Plugin.`, true);
  });

  await step("adding it saves a dashboard tile that opens the App through its own server", async () => {
    await adminUser.click("Add");
    const saved = await probe.eventually(() => world.dashboardElements(), {
      within: 60_000, intervalMs: 1_000, label: "the App's tile saved in Den", until: elements => elements.length === 1,
    });
    // The tile opens the App through its own server, which the desktop finds by App id.
    expect(saved).toEqual([appTile(world.created.resourceUri)]);
    await adminUser.click("Done");
    await adminUser.see({ text: "App built in OpenWork" }, { timeoutMs: 15_000 });
    await adminUser.screenshot();
    evidence.recordAssertionEvidence("The App's dashboard tile opens the App itself", `Adding ${appTitle} saved one tile that opens the App's own server, which the desktop finds by App id: connectionId ${world.created.appId}, open_app, and the App's current revision. The dashboard lists it as "App built in OpenWork".`, true);
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

  await step("the owner shares only the App's Plugin, and the teammate finds the App and its MCP URL there", async () => {
    // The App's Workflow tools run through its own Plugin, so no separate Workflow grant is needed.
    const read = payload(await world.call("owner", "read_app", { appId: world.created.appId }));
    const workflowTools = rows(record(read.app).tools).filter(tool => String(tool.capability).startsWith("plugin:"));
    expect(workflowTools).toHaveLength(2);
    expect(workflowTools.map(tool => tool.capability)).toEqual(workflowTools.map(() => expect.stringMatching(new RegExp(`^plugin:${world.created.pluginId}:`))));
    await world.share();
    expect((await world.index("member")).some(server => server.connectionId === world.created.appId && server.url === world.created.mcpUrl)).toBe(true);
    const pluginUser = user.on(world.pluginWeb);
    await pluginUser.navigate(`${world.den.ref.webUrl}/dashboard/library/plugins/${world.created.pluginId}`);
    await pluginUser.see({ testId: "plugin-page" }, { timeoutMs: 120_000 });
    await pluginUser.see({ role: "heading", label: appTitle });
    await pluginUser.see({ testId: "whats-inside" }, { text: new RegExp(appTitle) });
    await pluginUser.see({ testId: "app-mcp-servers" }, { text: new RegExp(`Use in another app\\s+${appTitle} MCP URL`) });
    await pluginUser.screenshot();
    evidence.recordAssertionEvidence("Sharing the App's Plugin shares its Workflows too", "create_app added both Workflows to the App's own Plugin, and only that Plugin was shared: the teammate's App host index now lists the App's MCP URL, and their Plugin page shows the App with its MCP URL for other MCP clients.", true);
  });

  await step("after: the teammate uses the same App URL, tools, and Workflows as themselves", async () => {
    const sinceIso = new Date().toISOString();
    const memberApp = await opened("member", "revision one", sinceIso);
    await user.see({ testId: "viewer" }, { text: "Signed in as a teammate" });
    await reserve(memberApp);
    await calculate(memberApp);
    expectCalls("member", [toolNames.reserve, toolNames.workflow]);
    expect(payload(clientCall("member", toolNames.workflow)?.result ?? {})).toMatchObject({ status: "executed", value: { total: 42 } });
    expect((await world.inventoryCalls({ sinceIso, atLeast: 1 })).map(call => call.args)).toEqual([{ sku: launchInput.sku }]);
    expect((await world.reservations({ sinceIso, atLeast: 1 })).map(call => call.args)).toEqual([reservation]);
    await user.screenshot();
    evidence.recordAssertionEvidence("A teammate uses the shared App as themselves", `With no grant on either Workflow, the teammate's calls ran the same four tools at the same MCP URL: the live Workflow and the Inventory lookup on open, then one reservation and one Workflow run on two clicks, which returned 42. Sharing never shared credentials.`, true);
  });

  await step("an update keeps the same MCP URL and tools, and the owner's App opens on the new revision", async () => {
    const { updated } = await world.update();
    updatedResourceUri = updated.resourceUri;
    expect(updated.serverPath).toBe(world.created.serverPath);
    expect(updated.revisionId).not.toBe(world.created.revisionId);
    const listed = rows((await world.rpc("owner", "app", "tools/list", {})).tools);
    expect(listed.map(tool => tool.name)).toEqual(composedTools);
    expect(listed[0]).toMatchObject({ _meta: { ui: { resourceUri: updated.resourceUri } } });
    expect(rows((await world.rpc("owner", "app", "resources/read", { uri: world.created.resourceUri })).contents)[0]).toMatchObject({ uri: world.created.resourceUri });
    expect(record((await world.rpc("owner", "app", "tools/call", { name: "open_app", arguments: {} })).structuredContent).app).toMatchObject({ revisionId: updated.revisionId });
    await opened("owner", "revision two", new Date().toISOString());
    expect((await world.hostState()).uri).toBe(updated.resourceUri);
    await user.screenshot();
    evidence.recordAssertionEvidence("Revisions stay behind the same MCP URL and tools", "update_app without tools published a new revision on the same App server with the same five tools. Opening the App again shows revision two with its reads loaded, and the original revision stays readable to the owner.", true);
  });

  await step("after the update, the dashboard tile opens the App's new revision for the owner and the teammate", async () => {
    expect(await world.dashboardElements()).toEqual([appTile(updatedResourceUri)]);
    expect(await world.teammateDashboardElements()).toEqual([appTile(updatedResourceUri)]);
    evidence.recordAssertionEvidence("A dashboard tile keeps opening the App after update_app", `The saved tile named revision one, and update_app published revision two. Den now serves the tile with the current revision, both to the admin and in the teammate's GET /v1/me/dashboards, which their desktop reads, so the tile keeps opening the App.`, true);
  });

  await step("a teammate without access still cannot use either revision", async () => {
    await frame?.[Symbol.asyncDispose]();
    frame = undefined;
    for (const resourceUri of [world.created.resourceUri, updatedResourceUri]) await refused("outsider", resourceUri);
    await user.navigate(world.url("outsider"));
    await user.see({ testId: "viewer" }, { text: "Signed in as a teammate without access" });
    await user.see({ text: "The App is not available." }, { timeoutMs: 60_000 });
    expect((await probe.dom("iframe")).elements).toHaveLength(0);
    await user.screenshot();
    evidence.recordAssertionEvidence("The negative half: no access, no App", "A teammate the Plugin is not shared with gets mcp_app_not_found for tools/list, tools/call, and both revisions' resources, and their index does not list the App.", true);
  });
});

chatTest("an owner prompts OpenWork's chat to build an App and to open one, and both work inside the conversation", async ({ world, agent, user, probe, step, evidence }) => {
  const modelTool = async (marker: string) => (await world.den.mocks.inventory.agentRequests({ promptMarker: marker })).find(request => request.kind === "tool");
  const lookups = async (sinceIso: string) => (await world.inventoryCalls({ sinceIso, atLeast: 1 })).map(call => call.args);
  const reservations = async (sinceIso: string) => (await world.reservations({ sinceIso, atLeast: 1 })).map(call => call.args);
  // One App frame is open at a time; it stays open across the steps that click in it.
  let frame: Awaited<ReturnType<typeof world.appFrame>> | undefined;
  await using _openFrame = { [Symbol.asyncDispose]: async () => { await frame?.[Symbol.asyncDispose](); } };
  const focus = async (title: string) => {
    await frame?.[Symbol.asyncDispose]();
    frame = await world.appFrame(title);
    return user.on(frame);
  };
  let builtAt = "";
  let openedAt = "";
  let pricer: Awaited<ReturnType<typeof focus>> | undefined;
  let calculator: Awaited<ReturnType<typeof focus>> | undefined;

  await step("the owner asks the chat to build an App in plain words, and it opens in the conversation with its pricing date and price, no click needed", async () => {
    builtAt = new Date().toISOString();
    await agent.send(buildPrompt);
    await user.see({ text: buildReply }, { timeoutMs: 120_000 });
    expect((await modelTool(buildPrompt))?.toolName).toMatch(/create_app$/);
    pricer = await focus(pricerTitle);
    await pricer.see({ role: "heading", label: pricerTitle });
    await pricer.see({ testId: "pricing-date" }, { text: /^Prices as of \d{4}-\d{2}-\d{2}$/, timeoutMs: 90_000 });
    // The provider marks the Inventory lookup read-only, so OpenWork runs it on open without a click.
    await pricer.see({ testId: "order-line" }, { text: pricedLine, timeoutMs: 90_000 });
    await pricer.notSee({ role: "button", label: "Look up price" });
    await pricer.notSee({ testId: "total" });
    expect(await lookups(builtAt)).toEqual([{ sku: launchInput.sku }]);
    expect(await world.reservations({ sinceIso: builtAt })).toEqual([]);
    await user.screenshot();
    evidence.recordAssertionEvidence("The chat builds the App, and opening it runs its read-only tools without a click", `For "${buildPrompt}", the model called create_app with ${pricerTitle}'s source and four declared tools. The App opened in the conversation and, with no click, loaded today's date from its live Workflow and the unit price from its Inventory lookup, which the provider marks read-only: the order line reads "${pricedLine}". The Inventory MCP recorded one lookup and no reservation.`, true);
  });

  await step("a click on Reserve stock from the App's own script is refused, because it is not a person's click", async () => {
    if (!pricer || !frame) throw new Error(`${pricerTitle} is not open`);
    await world.scriptedClick(frame, "Reserve stock");
    await pricer.see({ role: "alert" }, { text: /approval/i, timeoutMs: 60_000 });
    expect(await world.reservations({ sinceIso: builtAt })).toEqual([]);
    await user.screenshot();
    evidence.recordAssertionEvidence("A connection tool that is not read-only still needs a person's click", `The provider does not mark ${toolNames.reserve} read-only. A click from the App's own script called it, and OpenWork refused the call for want of a user click: the App shows the approval error, and the Inventory MCP recorded no reservation.`, true);
  });

  await step("one trusted click on Reserve stock reserves the stock once", async () => {
    if (!pricer) throw new Error(`${pricerTitle} is not open`);
    await pricer.click({ role: "button", label: "Reserve stock" });
    await pricer.see({ testId: "reservation" }, { text: reservedLine, timeoutMs: 90_000 });
    await pricer.notSee({ role: "alert" });
    expect(await reservations(builtAt)).toEqual([reservation]);
    expect(await lookups(builtAt)).toEqual([{ sku: launchInput.sku }]);
    await user.screenshot();
    evidence.recordAssertionEvidence("One real click runs the reservation once", `One trusted click on Reserve stock made exactly one ${toolNames.reserve} call, reserving ${launchInput.quantity} × ${launchInput.sku}; the App shows "${reservedLine}". The Inventory lookup still ran only once, on open.`, true);
  });

  await step("after: one click on Calculate total in the new App prices the order at 42", async () => {
    if (!pricer) throw new Error(`${pricerTitle} is not open`);
    await pricer.click({ role: "button", label: "Calculate total" });
    await pricer.see({ testId: "total" }, { text: "42", timeoutMs: 90_000 });
    await user.screenshot();
    evidence.recordAssertionEvidence("The new App's Workflow runs from its button", `Clicking Calculate total in ${pricerTitle} ran its ${toolNames.workflow} Workflow, which returned 42.`, true);
  });

  await step("the owner asks the chat to open the Order calculator for an order, naming no App, and it opens with that order", async () => {
    for (const id of [world.created.appId, world.created.pluginId]) expect(chatPrompt).not.toContain(id);
    openedAt = new Date().toISOString();
    await agent.send(chatPrompt);
    await user.see({ text: chatReply }, { timeoutMs: 120_000 });
    expect((await modelTool(chatPrompt))?.toolName).toMatch(/execute_capability$/);
    // The App's result tells the model the person already sees the App, so its reply stays short.
    const final = (await world.den.mocks.inventory.agentRequests({ promptMarker: chatPrompt })).find(request => request.kind === "final");
    expect(final?.toolResultCodes).toEqual([expect.objectContaining({ hasAppShownNote: true })]);
    calculator = await focus(appTitle);
    await calculator.see({ role: "heading", label: appTitle });
    await calculator.see({ testId: "pricing-date" }, { text: /^Prices as of \d{4}-\d{2}-\d{2}$/, timeoutMs: 90_000 });
    await calculator.see({ testId: "order-line" }, { text: pricedLine, timeoutMs: 90_000 });
    await calculator.notSee({ role: "button", label: "Look up price" });
    await calculator.notSee({ testId: "total" });
    expect(await lookups(openedAt)).toEqual([{ sku: launchInput.sku }]);
    expect(await world.reservations({ sinceIso: openedAt })).toEqual([]);
    await user.screenshot();
    evidence.recordAssertionEvidence("The chat opens an existing App with the order it was given", `"${chatPrompt}" carries no App, Plugin, or connection id. The model opened ${appTitle} with execute_capability and the launch input { sku: "${launchInput.sku}", quantity: ${launchInput.quantity} }. The App has no sample order of its own, yet with no click it shows "${pricedLine}": its live Workflow loaded today's date and its read-only Inventory lookup loaded the price. Nothing was reserved.`, true);
  });

  await step("one click on Reserve stock in the Order calculator reserves the stock once", async () => {
    if (!calculator) throw new Error(`${appTitle} is not open`);
    await calculator.click({ role: "button", label: "Reserve stock" });
    await calculator.see({ testId: "reservation" }, { text: reservedLine, timeoutMs: 90_000 });
    expect(await reservations(openedAt)).toEqual([reservation]);
    await user.screenshot();
    evidence.recordAssertionEvidence("The reservation runs once, from its own click", `Clicking Reserve stock in ${appTitle} made exactly one reservation of ${launchInput.quantity} × ${launchInput.sku}.`, true);
  });

  await step("after: one click on Calculate total prices the order, with no approval prompt", async () => {
    if (!calculator) throw new Error(`${appTitle} is not open`);
    await calculator.click({ role: "button", label: "Calculate total" });
    await calculator.see({ testId: "total" }, { text: "42", timeoutMs: 90_000 });
    await user.notSee({ text: "Allow App action?" });
    await user.screenshot();
    evidence.recordAssertionEvidence("Each trusted click runs its one tool", `Clicking Calculate total ran the ${toolNames.workflow} Workflow from the conversation, and ${appTitle} shows 42, with no extra approval prompt.`, true);
  });

  await step("asked for the calculator again, the chat keeps one live copy and the earlier card points to it", async () => {
    await frame?.[Symbol.asyncDispose]();
    frame = undefined;
    const newerNote = "This App has a newer version below.";
    await agent.send(reopenPrompt);
    await user.see({ text: reopenReply }, { timeoutMs: 120_000 });
    await user.see({ text: newerNote }, { timeoutMs: 30_000 });
    calculator = await focus(appTitle);
    await calculator.see({ role: "heading", label: appTitle });
    expect((await probe.dom(`[data-mcp-app-resource="${world.created.resourceUri}"] iframe`)).elements).toHaveLength(1);
    await user.screenshot();
    evidence.recordAssertionEvidence("Only an App's newest card stays live", `For "${reopenPrompt}" the model opened ${appTitle} a second time. The conversation shows one live ${appTitle}, the new card, and the earlier card now reads "${newerNote}", so the App is not loaded twice.`, true);
  });
});
