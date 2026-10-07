import { expect } from "vitest";
import { spec, type SpecBodyContext } from "@openwork/testkit";
import { appSource, appTitle, buildPrompt, buildReply, chatPrompt, chatReply, launchInput, mcpAppServers, mcpAppServersChat, mcpAppCreationV1, mcpAppCreationV2, mcpAppCreationDesktop, payload, pricerTitle, record, reopenPrompt, reopenReply, reservationId, rows, toolNames } from "../worlds/mcp-app-servers.ts";

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
const emptyDashboardHeading = "Pin the artifacts you check every day";

/** Compact dashboard tiles show their menu only while hovered (#5560), so point at the App inside the tile first. */
async function openTileMenu({ user, probe }: Pick<SpecBodyContext<unknown>, "user" | "probe">, admin: Parameters<SpecBodyContext<unknown>["probe"]["api"]>[0], title: string) {
  const apps = rows(record((await probe.api(admin, "/v1/mcp-apps")).body).apps);
  const resourceUri = String(apps.find(app => app.title === title)?.resourceUri ?? "");
  await user.hover({ mcpApp: { resourceUri }, role: "heading", label: title });
  await user.click({ role: "button", label: `Artifact options for ${title}` });
}

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

  await step("a new organization can build Apps without a platform admin turning anything on", async () => {
    expect([...world.builderToolsByDefault].sort()).toEqual(["create_app", "read_app", "update_app"]);
    const capabilities = record((await probe.api(world.den.admin, `/v1/admin/organizations/${world.organizationId}/capabilities`)).body).capabilities;
    expect(record(capabilities)).not.toHaveProperty("appMcpServers");
    evidence.recordAssertionEvidence("Building your own Apps is on by default", `Before any /admin change, Connect offered ${[...world.builderToolsByDefault].sort().join(", ")} to the new organization's owner, and /admin has no Apps built in OpenWork capability to turn on.`, world.builderToolsByDefault.length === 3);
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

  await step("the App's catalog entry saves a dashboard tile that opens the App through its own server", async () => {
    await world.addAppTile();
    // The tile opens the App through its own server, which the desktop finds by App id.
    expect(await world.dashboardElements()).toEqual([appTile(world.created.resourceUri)]);
    evidence.recordAssertionEvidence("The App's dashboard tile opens the App itself", `Den's App catalog lists ${appTitle}, and saving that entry as a tile stores one that opens the App's own server, which the desktop finds by App id: connectionId ${world.created.appId}, open_app, and the App's current revision.`, true);
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

chatTest("an owner follows App creation progress and opens the finished App beside the chat", async ({ world, agent, user, probe, step, evidence }) => {
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

  await step("before: the conversation has no App preview until an App is ready", async () => {
    expect((await probe.dom("[data-built-app-preview]")).elements).toHaveLength(0);
    await user.screenshot();
  });

  await step("after: the owner sees the agent writing the App after finding its tools", async () => {
    await world.holdCreation(true);
    builtAt = new Date().toISOString();
    await agent.send(buildPrompt);
    await user.see({ text: /Writing artifact “/ });
    // The row reaches "writing" only once the preparation result is recorded.
    expect(await probe.eventually(async () => (await probe.dom('[data-app-builder-step][data-app-creation-stage="writing"]')).elements, {
      within: 30_000, intervalMs: 200, label: "preparation completes while creation is held", until: elements => elements.length === 1,
    })).toHaveLength(1);
    expect((await probe.dom("[data-built-app-preview]")).elements).toHaveLength(0);
    await user.screenshot();
    evidence.recordAssertionEvidence("Creation progress follows the actual work", "The agent called prepare_app, which verified the four tools and returned a starter. While the agent was still writing, the creation row read Writing artifact with preparation complete, and no preview opened.", true);
    await world.holdCreation(false);
  });

  await step("after: a checked App opens as a tab beside the conversation", async () => {
    await user.see({ text: buildReply }, { timeoutMs: 120_000 });
    const calls = (await world.den.mocks.inventory.agentRequests({ promptMarker: buildPrompt })).filter(request => request.kind === "tool");
    expect(calls.map(call => call.toolName)).toEqual([expect.stringMatching(/prepare_app$/), expect.stringMatching(/create_app$/)]);
    expect(await probe.eventually(async () => (await probe.dom('[data-app-builder-step][data-app-creation-stage="ready"]')).elements, {
      within: 30_000, intervalMs: 200, label: "the checked App is ready to open", until: elements => elements.length === 1,
    })).toHaveLength(1);
    expect((await probe.dom('[data-app-builder-step] button[aria-expanded="false"]')).elements).toHaveLength(1);
    await user.see({ role: "button", label: "Open preview" });
    await user.see({ role: "button", label: "Share" });
    expect((await probe.dom("[data-built-app-preview]")).elements).toHaveLength(1);
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
    evidence.recordAssertionEvidence("The chat builds the App, and opening it runs its read-only tools without a click", `For "${buildPrompt}", the model called prepare_app and then create_app with ${pricerTitle}'s source and four declared tools. The App opened in the right preview and, with no click, loaded today's date from its live Workflow and the unit price from its Inventory lookup, which the provider marks read-only: the order line reads "${pricedLine}". The Inventory MCP recorded one lookup and no reservation.`, true);
  });

  await step("before: the owner’s finished App has a Share action beside the preview", async () => {
    await user.see({ role: "button", label: "Share" });
    await user.notSee({ text: "Who can use it" });
    await user.screenshot();
  });

  await step("after: Share opens the App’s current audience and people and team controls", async () => {
    await user.click({ role: "button", label: "Share" });
    await user.see({ text: "Who can use it" });
    await user.see({ role: "button", label: "Add person" });
    await user.see({ role: "button", label: "Add team" });
    await user.screenshot();
    evidence.recordAssertionEvidence("The owner can manage the App’s audience from its preview", "Share opens the normal audience screen for this App’s owning Plugin, with its existing grants and controls for people and teams. Merely opening the screen does not change access.", true);
    await user.click({ role: "button", label: "Cancel" });
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
    await frame?.[Symbol.asyncDispose]();
    frame = undefined;
    await user.click({ role: "button", label: "Close panel" });
    openedAt = new Date().toISOString();
    await agent.send(chatPrompt);
    await user.see({ text: chatReply }, { timeoutMs: 120_000 });
    expect((await modelTool(chatPrompt))?.toolName).toMatch(/execute_capability$/);
    // The App's result tells the model the person already sees the App, so its reply stays short.
    const final = (await world.den.mocks.inventory.agentRequests({ promptMarker: chatPrompt })).find(request => request.kind === "final");
    expect(final?.toolResultCodes).toEqual([expect.objectContaining({ hasAppShownNote: true })]);
    expect((await probe.dom("[data-built-app-preview]")).elements).toHaveLength(0);
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

  await step("before: building an App does not place it on the owner’s dashboard", async () => {
    await frame?.[Symbol.asyncDispose]();
    frame = undefined;
    await user.click({ role: "button", label: "Dashboard" });
    await user.see({ role: "heading", label: emptyDashboardHeading });
    expect((await probe.dom('[data-dashboard-tile^="personal:"]')).elements).toHaveLength(0);
    await user.screenshot();
  });

  await step("after: the owner chooses an existing App and uses it on their dashboard", async () => {
    await user.click({ role: "button", label: "Add an artifact" });
    await user.see({ label: "Search artifacts" });
    await user.type({ label: "Search artifacts" }, "qckordprcr", { replace: true });
    await user.screenshot();
    await user.click({ role: "option", label: `Add ${pricerTitle}` });
    expect((await probe.dom('[data-dashboard-tile^="personal:"]')).elements).toHaveLength(1);
    try { pricer = await focus(pricerTitle); }
    catch (error) { await user.screenshot(); throw error; }
    await pricer.see({ testId: "order-line" }, { text: pricedLine, timeoutMs: 90_000 });
    await user.screenshot();
    evidence.recordAssertionEvidence("An accessible built App can be added to a personal dashboard", "Fuzzy search finds Quick order pricer in the accessible App catalog. Choosing it adds one personal tile that opens the real App and loads its read-only data. Creation alone did not place it on the dashboard.", true);
  });

  await step("removing a dashboard tile keeps the App available to add again", async () => {
    // Undo is covered by the creation journeys; here the App is added back from the picker.
    await openTileMenu({ user, probe }, world.den.admin, pricerTitle);
    await user.click({ role: "menuitem", label: `Remove ${pricerTitle} from dashboard` });
    expect((await probe.dom('[data-dashboard-tile^="personal:"]')).elements).toHaveLength(0);
    await user.click({ role: "button", label: "Add an artifact" });
    await user.type({ label: "Search artifacts" }, "qckordprcr", { replace: true });
    await user.see({ role: "option", label: `Add ${pricerTitle}` });
    await user.screenshot();
    await user.click({ role: "option", label: `Add ${pricerTitle}` });
    expect((await probe.dom('[data-dashboard-tile^="personal:"]')).elements).toHaveLength(1);
    // A re-added tile shows its saved copy at once, then replaces that frame with the live App.
    // Read the order line from the frame that stays, once the tile has finished loading.
    expect(await probe.eventually(async () => (await probe.dom('[data-dashboard-tile^="personal:"][aria-busy="false"]')).elements, {
      within: 90_000, intervalMs: 200, label: "the re-added tile has replaced its saved copy with the live App", until: elements => elements.length === 1,
    })).toHaveLength(1);
    pricer = await focus(pricerTitle);
    await pricer.see({ testId: "order-line" }, { text: pricedLine, timeoutMs: 90_000 });
    evidence.recordAssertionEvidence("Removing a tile changes only personal placement", "After removing Quick order pricer, its tile is gone but the App remains in the Add picker, and adding it again restores a working tile; neither the App nor its sharing grants were deleted.", true);
  });

});


const creationV1Test = spec.world(mcpAppCreationV1, { resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, needs: { commands: ["bun", "pnpm", "opencode"] }, timeout: 600_000 });
const creationV2Test = spec.world(mcpAppCreationV2, { resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, needs: { commands: ["bun", "pnpm", "opencode"] }, timeout: 600_000 });
const creationDesktopTest = spec.world(mcpAppCreationDesktop, { resources: { surfaces: ["desktop"], services: ["den", "mock"], nativeReason: "Verify the App pane beside Electron's native composer and personal dashboard tile controls in the Desktop shell." }, needs: { commands: ["bun", "pnpm", "opencode"] }, timeout: 600_000 });

async function creationJourney({ world, agent, user, probe, step, evidence }: SpecBodyContext<Awaited<ReturnType<typeof mcpAppCreationV1>>>) {
    const name = world.engine + ("openworkUrl" in world.app ? " web" : " native Desktop");
    let frame: Awaited<ReturnType<typeof world.appFrame>> | undefined;
    const closeFrame = async () => { await frame?.[Symbol.asyncDispose](); frame = undefined; };
    await using cleanup = { [Symbol.asyncDispose]: async () => { await frame?.[Symbol.asyncDispose](); } };
    const revision = async (text: string) => {
      await frame?.[Symbol.asyncDispose]();
      frame = await world.appFrame(pricerTitle);
      await user.on(frame).see({ text: `Ready — ${text}` }, { timeoutMs: 90_000 });
    };
    await step("before: discovery and preparation have no App preview", async () => {
      await world.holdCreation(true);
      expect((await probe.dom("[data-built-app-preview]")).elements).toHaveLength(0);
      await agent.send(buildPrompt);
      await user.see({ text: /Writing artifact “/ }, { timeoutMs: 120_000 });
      expect(await probe.eventually(async () => (await probe.dom('[data-app-builder-step][data-app-creation-stage="writing"]')).elements, { within: 30_000, intervalMs: 200, label: "the actual preparation completes before checking the held writing stage", until: elements => elements.length === 1 })).toHaveLength(1);
      expect((await probe.dom("[data-built-app-preview]")).elements).toHaveLength(0);
      const calls = (await world.den.mocks.inventory.agentRequests({ promptMarker: buildPrompt })).filter(request => request.kind === "tool");
      expect(calls.length).toBeGreaterThanOrEqual(2);
      evidence.recordAssertionEvidence("Discovery and preparation are real calls before any preview", `${name}: the model requested discovery and preparation before the held build. The actual preparation result completes that stage, writing is active, and the preview remains absent.`, true);
      await user.screenshot();
      await world.holdCreation(false);
    });
    await step("after: a verified App opens beside the composer", async () => {
      await user.see({ text: buildReply }, { timeoutMs: 120_000 });
      expect((await probe.dom("[data-built-app-preview]")).elements).toHaveLength(1);
      await revision("revision one");
      evidence.recordJsonArtifact("Actual discovery and builder calls", await world.den.mocks.inventory.agentRequests({ promptMarker: buildPrompt }));
      await user.see({ role: "button", label: "Open preview" });
      const pane = (await probe.dom("[data-built-app-preview]")).elements[0]?.rect;
      const composer = (await probe.dom('textarea, [contenteditable="true"][role="textbox"]')).elements.find(element => element.rect.width > 0)?.rect;
      if (!pane || !composer) throw new Error("The preview or composer is not visible");
      expect(pane.left).toBeGreaterThanOrEqual(composer.right - 1);
      evidence.recordAssertionEvidence("Verified launch opens a usable App beside the composer", `${name}: one preview loads revision one; the rendered pane begins at ${pane.left}, beside the composer ending at ${composer.right}.`, true);
      await user.screenshot();
    });
    await step("after: editing refreshes the same tab and closing it permits reopening from the creation step", async () => {
      const prompt = "Update this App to revision two.";
      const appId = await world.prepareLifecycleTurn(prompt, "edit");
      await agent.send(prompt);
      await user.see({ text: "The App has been updated." }, { timeoutMs: 120_000 });
      expect((await probe.dom(`[data-built-app-preview="${appId}"]`)).elements).toHaveLength(1);
      expect((await probe.dom('[data-built-app-preview]')).elements).toHaveLength(1);
      await revision("revision two");
      await closeFrame();
      await user.click({ role: "button", label: "Close panel" });
      expect((await probe.dom('[data-built-app-preview]')).elements).toHaveLength(0);
      // Every creation step reopens the App's current revision, including the original step.
      await user.click({ role: "button", label: "Open preview", nth: 0 });
      await revision("revision two");
      expect((await probe.dom('[data-built-app-preview]')).elements).toHaveLength(1);
      evidence.recordAssertionEvidence("Edits preserve one tab; the original creation step reopens the current revision", `${name}: update_app targets the created App id. The preview contains revision two with one tab; closing removes the pane and Open preview restores revision two.`, true);
      await user.screenshot();
      await closeFrame();
      await user.click({ role: "button", label: "Close panel" });
    });
    await step("after: a failed build shows its failure and never opens a preview", async () => {
      const prompt = "Create an App with the invalid source to check the failure.";
      await world.prepareLifecycleTurn(prompt, "failure");
      await agent.send(prompt);
      await user.see({ text: /Couldn’t create artifact “Broken App”/ }, { timeoutMs: 120_000 });
      await user.see({ text: "The App could not be created." }, { timeoutMs: 30_000 });
      expect(await probe.eventually(async () => (await probe.dom('button[aria-label="Stop"]')).elements, { within: 30_000, intervalMs: 200, label: "the failed creation turn finishes before the next workload", until: elements => elements.length === 0 })).toHaveLength(0);
      expect((await probe.dom('[data-built-app-preview]')).elements).toHaveLength(0);
      evidence.recordAssertionEvidence("A real compilation failure never becomes readiness", `${name}: create_app rejects invalid source; the creation row says Couldn’t create artifact and opens no App.`, true);
      await user.screenshot();
    });
    await step("after: stopping creation pauses its step without opening an App", async () => {
      const prompt = "Create an App and hold while writing so I can stop it.";
      await world.prepareLifecycleTurn(prompt, "interrupt");
      await world.holdCreation(true);
      await agent.send(prompt);
      expect(await probe.eventually(async () => (await probe.dom('[data-app-builder-step][data-app-creation-stage="writing"] .ow-text-shimmer')).elements, { within: 60_000, intervalMs: 200, label: "the interrupted turn is actually writing before Stop", until: elements => elements.length === 1 && elements[0].rect.height > 0 })).toHaveLength(1);
      await user.click({ role: "button", label: "Stop" });
      await user.see({ text: "Paused" }, { timeoutMs: 30_000 });
      expect((await probe.dom('[data-app-builder-step] .ow-text-shimmer')).elements).toHaveLength(0);
      expect((await probe.dom('[data-built-app-preview]')).elements).toHaveLength(0);
      evidence.recordAssertionEvidence("Interrupted creation stays paused without an App", `${name}: the owner stops the held creation through the composer; no running stage or preview remains.`, true);
      await user.screenshot();
      await world.holdCreation(false);
    });
    await step("after: a personal tile can be refreshed, removed and restored without losing the App", async () => {
      await user.click({ role: "button", label: "Dashboard" });
      await user.see({ role: "heading", label: emptyDashboardHeading });
      await user.click({ role: "button", label: "Add an artifact" });
      await user.type({ label: "Search artifacts" }, pricerTitle, { replace: true });
      await user.click({ role: "option", label: new RegExp(pricerTitle) });
      await revision("revision two");
      await closeFrame();
      await openTileMenu({ user, probe }, world.den.admin, pricerTitle);
      await user.click({ role: "menuitem", label: `Refresh ${pricerTitle}` });
      await revision("revision two");
      await closeFrame();
      await openTileMenu({ user, probe }, world.den.admin, pricerTitle);
      await user.click({ role: "menuitem", label: `Remove ${pricerTitle} from dashboard` });
      expect((await probe.dom('[data-dashboard-tile^="personal:"]')).elements).toHaveLength(0);
      await user.click({ role: "button", label: "Undo" });
      expect((await probe.dom('[data-dashboard-tile^="personal:"]')).elements).toHaveLength(1);
      await revision("revision two");
      evidence.recordAssertionEvidence("Personal placement survives refresh, removal and Undo", `${name}: the real App shows revision two in its personal tile, refreshes through the tile menu, and remains usable after remove and Undo.`, true);
      await user.screenshot();
    });
}

creationV1Test("an owner creates, edits, reopens and stops an App on v1 web", creationJourney);
creationV2Test("an owner creates, edits, reopens and stops an App on v2 web", creationJourney);
creationDesktopTest("an owner creates, edits, reopens and stops an App on native Desktop", creationJourney);
