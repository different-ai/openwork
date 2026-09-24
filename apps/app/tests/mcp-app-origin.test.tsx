/** @jsxImportSource react */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createOpenworkServerClient, OpenworkServerError, type OpenworkMcpAppResource, type OpenworkServerClient } from "../src/app/lib/openwork-server";
import { createMcpAppActions } from "../src/components/chat/mcp-app-origin";
import { createMcpAppDiscoveryScheduler } from "../src/app/lib/mcp-app-discovery-scheduler";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());
const { McpAppFrame } = await import("../src/components/chat/mcp-app-frame");
const { MessageListProvider } = await import("../src/components/chat/message-list-provider");
const { WorkspaceProvider } = await import("../src/react-app/shell/workspace-provider");

const app: OpenworkMcpAppResource = {
  launchId: "launch-a", serverName: "fixture", toolName: "render", resourceUri: "ui://fixture/view.html",
  html: "<p>Fixture</p>", csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: true,
};
const result = { content: [{ type: "text", text: "ok" }] };
const needsApproval = () => new OpenworkServerError(422, "tool_requires_approval", "Approval required");

describe("App conversation ownership", () => {
  test("cancelling a scheduled discovery retry clears its timer and frees admission", async () => {
    const schedule = createMcpAppDiscoveryScheduler();
    let calls = 0;
    let retryTimer: number | undefined;
    const setTimer = window.setTimeout.bind(window);
    const timerSpy = spyOn(window, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (delay === 1_000) {
        retryTimer = setTimer(() => {}, 60_000);
        return retryTimer;
      }
      return setTimer(callback, delay, ...args);
    });
    const clearSpy = spyOn(window, "clearTimeout");
    const client = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
      resolveMcpApp: async () => { calls++; throw new OpenworkServerError(503, "mcp_unreachable", "Starting"); } };
    try {
      const cancel = schedule({ client, workspaceId: "w", sessionId: "s", readOnly: false }, "render", null, false, () => {}, () => {});
      await Promise.resolve();
      expect(retryTimer).toBeDefined();
      cancel();
      expect(clearSpy).toHaveBeenCalledWith(retryTimer);
      await Promise.resolve();
      expect(calls).toBe(1);
    } finally {
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      timerSpy.mockRestore(); clearSpy.mockRestore();
    }
  });

  test("many frames share auth failure, equivalent rerenders do not discover, changed launch scope does", async () => {
    const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    let calls = 0;
    const client = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
      resolveMcpApp: async () => { calls++; throw new OpenworkServerError(403, "mcp_auth_required", "Sign in required"); } };
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (id: number, reverse = false) => <MessageListProvider client={client} workspaceId="workspace" sessionId="session" readOnly={false}
      showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={0}
      dispatchAction={() => {}} setPrompt={() => {}} onRevertToUserMessage={() => {}} onForkAtMessage={() => {}}
      onEditUserMessage={() => {}} onMcpReconnect={async () => { throw new Error("unused"); }}
      onMcpReopenAuthorization={async () => {}}>
      {Array.from({ length: 40 }, (_, index) => <McpAppFrame key={index} part={{ type: "dynamic-tool", toolName: "fixture_render", toolCallId: `call-${index}`, state: "output-available", input: {}, output: {},
        callProviderMetadata: { openwork: { mcpResult: { content: [], _meta: { "openwork/mcpApp": {
          toolName: "render", resourceUri: "ui://fixture/view", arguments: reverse ? { other: true, id } : { id, other: true },
        } } } } } }} />)}
    </MessageListProvider>;
    try {
      await act(async () => { root.render(render(1)); });
      expect(calls).toBe(1);
      expect(container.querySelectorAll("button").length).toBe(80);
      await act(async () => { root.render(render(1, true)); });
      expect(calls).toBe(1);
      await act(async () => { root.render(render(2)); });
      expect(calls).toBe(2);
      await act(async () => { container.querySelector<HTMLButtonElement>("button")?.click(); });
      expect(calls).toBe(3);
    } finally {
      await act(async () => { root.unmount(); });
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    }
  });

  test.each([false, true])("split message origin survives discovery recovery and archive changes (retry: %j)", async (retry) => {
    const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const requests: unknown[] = [];
    const retryCallbacks: (() => void)[] = [];
    const delays: number[] = [];
    const setTimer = window.setTimeout.bind(window);
    const timerSpy = spyOn(window, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (typeof callback === "function" && (delay === 1_000 || delay === 3_000)) {
        const timer = setTimer(() => {}, 60_000);
        retryCallbacks.push(() => { window.clearTimeout(timer); callback(...args); });
        delays.push(delay);
        return timer;
      }
      return setTimer(callback, delay, ...args);
    });
    let toolCalls = 0;
    const primary = { ...createOpenworkServerClient({ baseUrl: "http://primary.invalid" }),
      resolveMcpApp: async () => { throw new Error("Must not use the primary endpoint"); } };
    const secondary: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://secondary.invalid" }),
      resolveMcpApp: async (workspaceId, name, launch, context) => {
        requests.push({ workspaceId, name, launch, context });
        if (retry && requests.length <= 3) throw new OpenworkServerError(503, "mcp_unreachable", "Starting");
        return { app: null };
      },
      callMcpAppTool: async () => { toolCalls++; return result; },
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (readOnly: boolean) => <WorkspaceProvider client={null} openworkServerClient={primary} workspaceId="workspace-a" selectedWorkspaceRoot="/a">
      <MessageListProvider client={secondary} workspaceId="workspace-b" sessionId="session-b" readOnly={readOnly}
        showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={0}
        dispatchAction={() => {}} setPrompt={() => {}} onRevertToUserMessage={() => {}} onForkAtMessage={() => {}}
        onEditUserMessage={() => {}} onMcpReconnect={async () => { throw new Error("unused"); }}
        onMcpReopenAuthorization={async () => {}}>
        <McpAppFrame part={{ type: "dynamic-tool", toolName: "fixture_render", toolCallId: "call-b", state: "output-available", input: {}, output: {},
          callProviderMetadata: { openwork: { mcpResult: { content: [] } } } }} />
      </MessageListProvider>
    </WorkspaceProvider>;
    try {
      await act(async () => { root.render(render(false)); });
      if (retry) {
        for (let i = 0; i < 2; i++) {
          const callback = retryCallbacks.shift();
          if (!callback) throw new Error("Missing discovery retry");
          await act(async () => callback());
        }
        expect(requests).toHaveLength(3);
        expect(delays).toEqual([1_000, 3_000]);
        expect(retryCallbacks).toEqual([]);
        const button = container.querySelector<HTMLButtonElement>("button");
        expect(button?.textContent).toBe("Retry");
        await act(async () => button?.click());
        expect(requests).toHaveLength(4);
        expect(container.querySelector("button")).toBeNull();
      }
      await act(async () => { root.render(render(true)); });
      expect(requests).toEqual([
        ...Array.from({ length: retry ? 4 : 1 }, () => ({ workspaceId: "workspace-b", name: "fixture_render", launch: undefined, context: { client: secondary, workspaceId: "workspace-b", sessionId: "session-b", readOnly: false } })),
        { workspaceId: "workspace-b", name: "fixture_render", launch: undefined, context: { client: secondary, workspaceId: "workspace-b", sessionId: "session-b", readOnly: true } },
      ]);
      expect(toolCalls).toBe(0);
    } finally {
      await act(async () => { root.unmount(); });
      timerSpy.mockRestore();
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    }
  });

  test.each(["read_detail", "write_detail"])("App calls dispatch once with the exact launch and no host confirmation: %s", async (name) => {
    const requests: unknown[] = [];
    const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://secondary.invalid" }),
      callMcpAppTool: async (workspaceId, payload) => {
        requests.push({ workspaceId, payload });
        if (!payload.approved) throw needsApproval();
        return result;
      } };
    const actions = createMcpAppActions({ client, workspaceId: "workspace-b", sessionId: "session-b", engine: "v2", readOnly: false }, app);
    const confirmSpy = spyOn(window, "confirm").mockReturnValue(false);
    try {
      expect(await actions.callTool(name, { id: "b" }, true)).toEqual(result);
      expect(requests).toEqual([{ workspaceId: "workspace-b", payload: {
        launchId: "launch-a", sessionId: "session-b", engine: "v2", serverName: "fixture", resourceUri: app.resourceUri,
        name, arguments: { id: "b" }, approved: true,
      } }]);
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    } finally {
      confirmSpy.mockRestore();
      actions.dispose();
    }
  });

  test.each([
    new OpenworkServerError(403, "tool_denied", "Forbidden"),
    new Error("tool_requires_approval"),
    needsApproval(),
    new OpenworkServerError(403, "forbidden", "Collaborator scope required"),
  ])("does not retry denied, challenged, or uncertain actions: %s", async (failure) => {
    const approvals: Array<boolean | undefined> = [];
    const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
      callMcpAppTool: async (_workspace, payload) => { approvals.push(payload.approved); throw failure; } };
    const actions = createMcpAppActions({ client, workspaceId: "b", sessionId: "b", readOnly: false }, app);
    await expect(actions.callTool("write_detail", undefined, true)).rejects.toBe(failure);
    expect(approvals).toEqual([true]);
  });

  test("unmount before a failed response prevents retry and subsequent dispatch", async () => {
    let reject: (error: Error) => void = () => { throw new Error("Missing pending call"); };
    let calls = 0;
    const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
      callMcpAppTool: async () => { calls++; return new Promise((_, fail) => { reject = fail; }); } };
    const actions = createMcpAppActions({ client, workspaceId: "b", sessionId: "b", readOnly: false }, app);
    const pending = actions.callTool("write_detail");
    actions.dispose();
    reject(needsApproval());
    await expect(pending).rejects.toThrow("closed or changed");
    await expect(actions.callTool("write_detail")).rejects.toThrow("closed or changed");
    expect(calls).toBe(1);
  });

  test("a result completing after disposal is discarded", async () => {
    let complete: (value: typeof result) => void = () => { throw new Error("Missing pending call"); };
    let calls = 0;
    let started: () => void = () => {};
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
      callMcpAppTool: async () => {
        calls++;
        return new Promise(resolve => { complete = resolve; started(); });
      } };
    const actions = createMcpAppActions({ client, workspaceId: "b", sessionId: "b", readOnly: false }, app);
    const pending = actions.callTool("write_detail");
    await waiting;
    actions.dispose();
    complete(result);
    await expect(pending).rejects.toThrow("closed or changed");
    expect(calls).toBe(1);
  });

  test("App calls snapshot their arguments without sharing a pending decision", async () => {
    const calls: Array<{ approved?: boolean; arguments?: Record<string, unknown> }> = [];
    const completions: Array<() => void> = [];
    const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
      callMcpAppTool: async (_workspace, payload) => {
        calls.push(payload);
        return new Promise(resolve => completions.push(() => resolve(result)));
      } };
    const actions = createMcpAppActions({ client, workspaceId: "b", sessionId: "b", readOnly: false }, app);
    const args = { nested: { value: "original" } };
    const first = actions.callTool("write_detail", args, true);
    args.nested.value = "changed";
    const second = actions.callTool("another_write", undefined, true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ approved: true, arguments: { nested: { value: "original" } } });
    expect(Object.isFrozen(calls[0]?.arguments?.nested)).toBe(true);
    expect(calls[1]).toMatchObject({ approved: true });
    completions.forEach(complete => complete());
    expect(await Promise.all([first, second])).toEqual([result, result]);
    actions.dispose();
  });

  test("background reads run without approval, but writes never escalate or retry", async () => {
    const calls: Array<{ name: string; approved?: boolean }> = [];
    const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
      callMcpAppTool: async (_workspace, payload) => {
        calls.push(payload);
        if (payload.name === "write_detail" && !payload.approved) throw needsApproval();
        return result;
      } };
    const actions = createMcpAppActions({ client, workspaceId: "b", sessionId: "b", readOnly: false }, app);
    expect(await actions.callTool("read_detail")).toEqual(result);
    await expect(actions.callTool("write_detail")).rejects.toMatchObject({ code: "tool_requires_approval" });
    expect(calls.map(({ name, approved }) => ({ name, approved }))).toEqual([
      { name: "read_detail", approved: undefined }, { name: "write_detail", approved: undefined },
    ]);
    actions.dispose();
  });

  test("read-only previews and missing leases cannot call tools or open links", async () => {
    let calls = 0;
    const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
      callMcpAppTool: async () => { calls++; return result; } };
    for (const readOnly of [true, false]) {
      const actions = createMcpAppActions({ client, workspaceId: "b", sessionId: "b", readOnly }, { ...app, launchId: readOnly ? app.launchId : undefined });
      expect(() => actions.assertActive()).toThrow(readOnly ? "read-only" : "no live launch context");
      await expect(actions.callTool("read_detail", undefined, true)).rejects.toThrow(readOnly ? "read-only" : "no live launch context");
    }
    expect(calls).toBe(0);
  });
});
