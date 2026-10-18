import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DynamicToolUIPart, UIMessage } from "ai";

GlobalRegistrator.register({ url: "https://web.example/" });
const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform");
const { MessageListProvider } = await import("../src/components/chat/message-list-provider");
const { MessageList } = await import("../src/components/chat/message-list");
let mounted: { root: Root; container: HTMLElement } | null = null;
afterEach(async () => { if (mounted) { await act(async () => mounted!.root.unmount()); mounted.container.remove(); mounted = null; } });
afterAll(() => { Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous); GlobalRegistrator.unregister(); });

const guide: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork_get_skill", toolCallId: "guide", input: { name: "build-an-app" }, state: "output-error", errorText: "Request access before retrying." };
async function render(parts: UIMessage["parts"]) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); mounted = { root, container };
  const messages: UIMessage[] = [{ id: "user", role: "user", parts: [{ type: "text", text: "Build a project board" }] }, {
    id: "reply", role: "assistant", parts: [...parts, { type: "text", text: "The report is ready." }], metadata: { opencode: { created: 1000, completed: 8000 } },
  }];
  await act(async () => root.render(createElement(PlatformProvider, { value: createDefaultPlatform(), children: createElement(MessageListProvider, {
    workspaceId: "fixture", sessionId: "fixture", showThinking: true, developerMode: false, displaySuggestions: false, providerConnectedCount: 0,
    dispatchAction: () => {}, setPrompt: () => {}, onRevertToUserMessage: () => {}, onForkAtMessage: () => {}, onEditUserMessage: () => {}, onMcpReconnect: async (): Promise<"connected"> => "connected", onMcpReopenAuthorization: async () => {},
    children: createElement(MessageList, { messages, status: "ready", activityStatus: "idle" }),
  }) })));
  return container;
}
const thoughts: UIMessage["parts"] = Array.from({ length: 6 }, (_, index) => ({ type: "dynamic-tool", toolName: "openwork_read_report", toolCallId: `read-${index}`, state: "output-available", input: { section: index }, output: "Checked" }));

test("failed guide stays inline outside every collapsed disclosure", async () => {
  const container = await render([...thoughts, guide]);
  const failure = container.querySelector("[data-app-builder-failure]");
  expect(failure?.textContent).toContain("Couldn’t load “build-an-app” instructions");
  expect(failure?.closest("[hidden]")).toBeNull();
  expect(container.querySelector('[data-testid="completed-work-rail"]')).toBeNull();
  expect(container.textContent).not.toContain("Read the build guide");
});

test("failed preparation does not complete earlier invented stages", async () => {
  const preparation: DynamicToolUIPart = { ...guide, toolName: "openwork_prepare_app", toolCallId: "prepare", input: { title: "Project board" } };
  const container = await render([preparation]);
  expect(container.querySelector("[data-app-builder-status]")?.textContent).toBe("Needs attention");
  expect(container.querySelector("[data-app-builder-checklist]")).toBeNull();
  expect(container.textContent).toContain("App “Project board”");
  expect(container.textContent).not.toContain("Tools ready");
});

test("a caught guide failure stays visible when the App and parent script succeed", async () => {
  const appId = "cob_00000000000000000000000000";
  const revisionId = "cov_00000000000000000000000000";
  const resourceUri = `ui://openwork/apps/${appId}/revisions/${revisionId}/index.html`;
  const app = { appId, revisionId, pluginId: "plg_00000000000000000000000000", title: "Project board", description: null, textFallback: "The board is saved.", toolName: "open_app", resourceUri, serverPath: `/mcp/agent/connections/${appId}`, tools: [] };
  const launch = { connectionId: appId, toolName: "open_app", resourceUri, arguments: {} };
  const script: DynamicToolUIPart = { type: "dynamic-tool", toolName: "execute", toolCallId: "script", input: { code: "try { get_skill() } catch {} create_app()" }, state: "output-available", output: "done", callProviderMetadata: { openwork: { codeMode: {
    calls: [{ tool: "openwork.get_skill", input: { name: "build-an-app" }, status: "error" }, { tool: "openwork.create_app", input: { title: "Project board" }, status: "completed" }],
    details: [{ invocationId: "script:0", ordinal: 0, tool: "openwork_get_skill", input: { name: "build-an-app" }, status: "error", startedAt: 1, error: "Instructions unavailable. Request access before retrying." }],
  } } } };
  const built: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork_create_app", toolCallId: "script:app:openwork_create_app:0", input: { title: "Project board" }, state: "output-available", output: { app, launch }, callProviderMetadata: { openwork: { mcpResult: { content: [], structuredContent: { app }, _meta: { "openwork/mcpApp": launch } } } } };
  const container = await render([...thoughts, script, built]);
  const failure = container.querySelector("[data-code-mode-failure]");
  expect(failure?.textContent).toContain("Couldn’t load “build-an-app” instructions");
  expect(failure?.closest("[hidden]")).toBeNull();
  expect(container.querySelector("[data-app-builder-status]")?.textContent).toBe("Saved");
  expect(container.querySelector('[data-testid="completed-work-rail"]')).toBeNull();
});

for (const output of ["done", "---\nname: review\n---\nThese are only the script's returned words."]) test("a script's return value cannot attest a status-only inner skill read", async () => {
  const script: DynamicToolUIPart = { type: "dynamic-tool", toolName: "execute", toolCallId: "script", input: { code: "await get_skill(); return text;" }, state: "output-available", output, callProviderMetadata: { openwork: { codeMode: { calls: [{ tool: "openwork.get_skill", input: { name: "review" }, status: "completed" }] } } } };
  const container = await render([script]);
  expect(container.textContent).toContain("Found “review” skill details");
  expect(container.textContent).not.toContain("Loaded “review” instructions");
});

test("a script's own failure stays visible beside its completed inner App result", async () => {
  const script: DynamicToolUIPart = { type: "dynamic-tool", toolName: "execute", toolCallId: "script", input: { code: "create_app(); throw Error()" }, state: "output-error", errorText: "Later script failure", callProviderMetadata: { openwork: { codeMode: { calls: [{ tool: "openwork.create_app", input: {}, status: "completed" }] } } } };
  const built: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork_create_app", toolCallId: "script:app:openwork_create_app:0", input: { title: "Project board" }, state: "output-available", output: { unrecorded: true }, callProviderMetadata: { openwork: { mcpResult: { structuredContent: { unrecorded: true } } } } };
  const container = await render([script, built]);
  expect(container.querySelector("[data-code-mode-script-error]")?.textContent).toContain("Later script failure");
  expect(container.querySelector("[data-app-builder-status]")?.textContent).toBe("Result not recorded");
});

test("a represented App rejection has one inline home beside the script's own error", async () => {
  const script: DynamicToolUIPart = { type: "dynamic-tool", toolName: "execute", toolCallId: "script", input: { code: "prepare_app(); create_app(); throw Error()" }, state: "output-error", errorText: "Later script failure", callProviderMetadata: { openwork: { codeMode: {
    calls: [{ tool: "openwork.prepare_app", input: { title: "Project board" }, status: "error" }, { tool: "openwork.create_app", input: { title: "Project board" }, status: "completed" }],
    details: [{ invocationId: "script:0", ordinal: 0, tool: "openwork_prepare_app", status: "error", input: { title: "Project board" }, startedAt: 1, error: "Review the selected tools." }],
  } } } };
  const preparation: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork_prepare_app", toolCallId: "script:app:openwork_prepare_app:0", state: "output-error", input: { title: "Project board" }, errorText: "Review the selected tools." };
  const built: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork_create_app", toolCallId: "script:app:openwork_create_app:0", input: { title: "Project board" }, state: "output-available", output: { unrecorded: true }, callProviderMetadata: { openwork: { mcpResult: { structuredContent: { unrecorded: true } } } } };
  const container = await render([script, preparation, built]);
  expect(container.querySelectorAll('[data-capability-call="openwork_prepare_app"]').length).toBe(1);
  expect(container.querySelector("[data-code-mode-script-error]")?.textContent).toContain("Later script failure");
  expect(container.querySelectorAll("[data-app-builder-failure]").length).toBe(1);
});

test("loaded skill instructions remain inspectable beside collapsed work", async () => {
  const loaded: DynamicToolUIPart = { type: "dynamic-tool", toolName: "skill", toolCallId: "skill", input: { name: "review" }, state: "output-available", output: "<skill_content>Check each report section.</skill_content>" };
  const container = await render([...thoughts, loaded]);
  const receipt = container.querySelector('[data-skill-evidence="instructions-loaded"]');
  expect(receipt?.textContent).toContain("Loaded “review” instructions");
  expect(receipt?.closest("[hidden]")).toBeNull();
  expect(container.querySelector('[data-testid="completed-work-rail"]')?.tagName).toBe("BUTTON");
  expect(container.textContent).not.toContain("Using your");
});
