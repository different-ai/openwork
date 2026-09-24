import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appTitle, launchInput, mcpAppServers, payload, rows, toolName } from "../worlds/mcp-app-servers.ts";

const test = spec.world(mcpAppServers, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 600_000,
});

test("an owner builds an App that is its own MCP server and a teammate uses it from a standard host once its Plugin is shared", async ({ world, user, probe, step, evidence }) => {
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
  const refused = async (persona: "member" | "outsider", resourceUri: string) => {
    expect((await world.rpc(persona, "app", "tools/list", {})).rpcError).toMatchObject({ code: -32600, data: { error: "mcp_app_not_found" } });
    expect((await world.rpc(persona, "app", "tools/call", { name: toolName, arguments: launchInput })).rpcError).toMatchObject({ data: { error: "mcp_app_not_found" } });
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

  await step("after: the owner opens the App from its own MCP URL, which exposes only open_app and its declared Workflow tool", async () => {
    expect(world.created.mcpUrl.endsWith(`/mcp/agent/connections/${world.created.appId}`)).toBe(true);
    const listed = rows((await world.rpc("owner", "app", "tools/list", {})).tools);
    expect(listed.map(tool => tool.name)).toEqual(["open_app", toolName]);
    expect(listed[0]).toMatchObject({ annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: world.created.resourceUri, visibility: ["model", "app"] } } });
    expect(listed[1]).toMatchObject({ annotations: { readOnlyHint: false }, inputSchema: { type: "object", required: ["quantity", "unitPrice"] } });
    await using frame = await open("owner");
    const appUser = user.on(frame);
    await appUser.see({ role: "heading", label: appTitle });
    await appUser.see({ text: "Ready — revision one" });
    await appUser.click({ role: "button", label: "Calculate total" });
    await appUser.see({ testId: "total" }, { text: "42", timeoutMs: 90_000 });
    const calls = clientCalls("owner");
    expect(calls.map(request => request.params.name)).toEqual(["open_app", toolName]);
    expect(calls[1]?.params.arguments).toEqual(launchInput);
    expect(payload(calls[1]?.result ?? {})).toMatchObject({ status: "executed", value: { total: 42 } });
    expect(world.requests.filter(request => request.via === "client").every(request => request.endpoint === "app")).toBe(true);
    expect((await world.hostState()).uri).toBe(world.created.resourceUri);
    await user.screenshot();
    evidence.recordAssertionEvidence("The App is a standalone standard MCP server", `The reference host used only ${world.created.serverPath}: its tools/list is exactly open_app and ${toolName}, and ${toolName} ran the owner's saved Workflow to return 42 without any Connect tool.`, true);
  });

  await step("the owner's OpenWork Connect lists the App as its own server and opens it by launch reference", async () => {
    const index = await world.index("owner");
    expect(index.filter(server => server.connectionId === world.created.appId)).toEqual([{
      connectionId: world.created.appId, name: appTitle, description: null, url: world.created.mcpUrl, exposeDirectly: true,
    }]);
    const search = payload(await world.call("owner", "search_capabilities", { query: appTitle, type: "marketplace" }));
    expect(rows(search.matches).find(match => match.name === appName)).toMatchObject({ kind: "mcp_app", mcpApp: { resourceUri: world.created.resourceUri } });
    const opened = await world.call("owner", "execute_capability", { name: appName });
    expect(opened._meta).toEqual({ "openwork/mcpApp": { connectionId: world.created.appId, toolName: "open_app", resourceUri: world.created.resourceUri, arguments: { input: {} } } });
    evidence.recordAssertionEvidence("OpenWork registers and opens the App like a directly exposed connection", "The Connect server index lists the App at its MCP URL with exposeDirectly, and executing its search match returns an openwork/mcpApp launch reference to open_app on that server.", true);
  });

  await step("after: sharing the Plugin lets the teammate use the same App URL as themselves", async () => {
    await world.share();
    expect((await world.index("member")).some(server => server.connectionId === world.created.appId && server.url === world.created.mcpUrl)).toBe(true);
    {
      await using frame = await open("member");
      const appUser = user.on(frame);
      await appUser.see({ text: "Ready — revision one" });
      await appUser.click({ role: "button", label: "Calculate total" });
      await appUser.see({ testId: "total" }, { text: "42", timeoutMs: 90_000 });
    }
    const calls = clientCalls("member");
    expect(calls.map(request => request.params.name)).toEqual(["open_app", toolName]);
    expect(payload(calls[1]?.result ?? {})).toMatchObject({ status: "executed", value: { total: 42 } });
    const pluginUser = user.on(world.pluginWeb);
    await pluginUser.navigate(`${world.den.ref.webUrl}/dashboard/library/plugins/${world.created.pluginId}`);
    await pluginUser.see({ testId: "plugin-page" }, { timeoutMs: 120_000 });
    await pluginUser.see({ role: "heading", label: appTitle });
    await pluginUser.see({ testId: "whats-inside" }, { text: new RegExp(appTitle) });
    await pluginUser.see({ testId: "app-mcp-servers" }, { text: `${appTitle} MCP URL` });
    await pluginUser.screenshot();
    evidence.recordAssertionEvidence("Plugin sharing shares the App server, not credentials", "After the Plugin and Workflow are shared, the teammate's index lists the same MCP URL, their own call to price_total returns 42, and the Plugin page offers the App's MCP URL for other MCP clients.", true);
  });

  await step("an update keeps the same MCP URL and tool while an outsider still cannot use either revision", async () => {
    const { updated } = await world.update();
    expect(updated.serverPath).toBe(world.created.serverPath);
    expect(updated.revisionId).not.toBe(world.created.revisionId);
    const listed = rows((await world.rpc("owner", "app", "tools/list", {})).tools);
    expect(listed.map(tool => tool.name)).toEqual(["open_app", toolName]);
    expect(listed[0]).toMatchObject({ _meta: { ui: { resourceUri: updated.resourceUri } } });
    expect(rows((await world.rpc("owner", "app", "resources/read", { uri: world.created.resourceUri })).contents)[0]).toMatchObject({ uri: world.created.resourceUri });
    for (const resourceUri of [world.created.resourceUri, updated.resourceUri]) await refused("outsider", resourceUri);
    await user.navigate(world.url("outsider"));
    await user.see({ text: "The App is not available." }, { timeoutMs: 60_000 });
    expect((await probe.dom("iframe")).elements).toHaveLength(0);
    await user.screenshot();
    evidence.recordAssertionEvidence("Revisions stay behind the same MCP URL and access", "update_app published a new revision on the same App server with the same tools; the original revision stays readable to the owner, and the ungranted teammate is refused for both.", true);
  });
});
