/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createOpenworkServerClient, OpenworkServerError, type OpenworkMcpAppResource, type OpenworkServerClient } from "../src/app/lib/openwork-server";
import { createMcpAppActions } from "../src/components/chat/mcp-app-origin";
import { McpAppFrame } from "../src/components/chat/mcp-app-frame";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { WorkspaceProvider } from "../src/react-app/shell/workspace-provider";

const app: OpenworkMcpAppResource = {
  launchId: "launch-a", serverName: "fixture", toolName: "render", resourceUri: "ui://fixture/view.html",
  html: "<p>Fixture</p>", csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: true,
};
const result = { content: [{ type: "text", text: "ok" }] };
const needsApproval = () => new OpenworkServerError(422, "tool_requires_approval", "Approval required");

describe("App conversation ownership", () => {
  test("split message origin supplies endpoint, workspace, session and archive state instead of the root workspace", async () => {
    GlobalRegistrator.register({ url: "http://localhost/" });
    const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const requests: unknown[] = [];
    const primary = { ...createOpenworkServerClient({ baseUrl: "http://primary.invalid" }),
      resolveMcpApp: async () => { throw new Error("Must not use the primary endpoint"); } };
    const secondary: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://secondary.invalid" }),
      resolveMcpApp: async (workspaceId, name, launch, context) => { requests.push({ workspaceId, name, launch, context }); return { app: null }; } };
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (readOnly: boolean) => <WorkspaceProvider client={null} openworkServerClient={primary} workspaceId="workspace-a" selectedWorkspaceRoot="/a">
      <MessageListProvider client={secondary} workspaceId="workspace-b" sessionId="session-b" readOnly={readOnly}
        showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={0}
        dispatchAction={() => {}} setPrompt={() => {}} onRevertToUserMessage={() => {}} onForkAtMessage={() => {}}
        onEditUserMessage={() => {}} onMcpReconnect={async () => { throw new Error("unused"); }}
        onMcpReopenAuthorization={async () => {}} onMcpRetry={() => {}}>
        <McpAppFrame part={{ type: "dynamic-tool", toolName: "fixture_render", toolCallId: "call-b", state: "output-available", input: {}, output: {},
          callProviderMetadata: { openwork: { mcpResult: { content: [] } } } }} />
      </MessageListProvider>
    </WorkspaceProvider>;
    try {
      await act(async () => { root.render(render(false)); });
      await act(async () => { root.render(render(true)); });
      expect(requests).toEqual([
        { workspaceId: "workspace-b", name: "fixture_render", launch: undefined, context: { client: secondary, workspaceId: "workspace-b", sessionId: "session-b", readOnly: false } },
        { workspaceId: "workspace-b", name: "fixture_render", launch: undefined, context: { client: secondary, workspaceId: "workspace-b", sessionId: "session-b", readOnly: true } },
      ]);
    } finally {
      await act(async () => { root.unmount(); });
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
      await GlobalRegistrator.unregister();
    }
  });

  test("follow-up and approved calls retain the exact launch and originating endpoint", async () => {
    const requests: unknown[] = [];
    const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://secondary.invalid" }),
      callMcpAppTool: async (workspaceId, payload) => {
        requests.push({ workspaceId, payload });
        if (!payload.approved) throw needsApproval();
        return result;
      } };
    const actions = createMcpAppActions({ client, workspaceId: "workspace-b", sessionId: "session-b", readOnly: false }, app, () => true);
    expect(await actions.callTool("write_detail", { id: "b" })).toEqual(result);
    expect(requests).toEqual([false, true].map(approved => ({ workspaceId: "workspace-b", payload: {
      launchId: "launch-a", sessionId: "session-b", serverName: "fixture", resourceUri: app.resourceUri,
      name: "write_detail", arguments: { id: "b" }, ...(approved ? { approved: true } : {}),
    } })));
  });

  test("unmount before an approval response neither prompts nor dispatches again", async () => {
    let reject: (error: Error) => void = () => { throw new Error("Missing pending call"); };
    let calls = 0;
    let prompts = 0;
    const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
      callMcpAppTool: async () => { calls++; return new Promise((_, fail) => { reject = fail; }); } };
    const actions = createMcpAppActions({ client, workspaceId: "b", sessionId: "b", readOnly: false }, app, () => { prompts++; return true; });
    const pending = actions.callTool("write_detail");
    actions.dispose();
    reject(needsApproval());
    await expect(pending).rejects.toThrow("closed or changed");
    expect(calls).toBe(1);
    expect(prompts).toBe(0);
  });

  test("an approval that completes after disposal cannot dispatch", async () => {
    let approve: (value: boolean) => void = () => { throw new Error("Missing approval"); };
    let calls = 0;
    const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
      callMcpAppTool: async () => { calls++; throw needsApproval(); } };
    let prompted: () => void = () => {};
    const shown = new Promise<void>(resolve => { prompted = resolve; });
    const actions = createMcpAppActions({ client, workspaceId: "b", sessionId: "b", readOnly: false }, app,
      () => new Promise<boolean>(resolve => { approve = resolve; prompted(); }));
    const pending = actions.callTool("write_detail");
    await shown;
    actions.dispose();
    approve(true);
    await expect(pending).rejects.toThrow("closed or changed");
    expect(calls).toBe(1);
  });

  test("read-only previews and missing leases cannot call tools or open links", async () => {
    let calls = 0;
    const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
      callMcpAppTool: async () => { calls++; return result; } };
    for (const readOnly of [true, false]) {
      const actions = createMcpAppActions({ client, workspaceId: "b", sessionId: "b", readOnly }, { ...app, launchId: undefined }, () => true);
      expect(() => actions.assertActive()).toThrow(readOnly ? "read-only" : "no live launch context");
      await expect(actions.callTool("read_detail")).rejects.toThrow(readOnly ? "read-only" : "no live launch context");
    }
    expect(calls).toBe(0);
  });
});
