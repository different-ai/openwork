/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DynamicToolUIPart } from "ai";
import { mcpAppResourceUri } from "@openwork/types/mcp-app";
import type { AppCreationRun } from "../src/react-app/domains/apps/app-creation-progress";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const lifecycle = await import("../src/components/chat/current-tool-lifecycle-context");
const messageList = await import("../src/components/chat/message-list-provider");
const previews = await import("../src/react-app/domains/apps/built-app-chat-preview");
const { AppBuilderStep } = await import("../src/components/chat/app-builder-step");
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let waiting = false;
let reconnecting = false;

beforeEach(() => {
  waiting = false;
  reconnecting = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  spyOn(lifecycle, "useCurrentSessionActivityStatus").mockImplementation(() => waiting ? "waiting" : "responding");
  spyOn(messageList, "useOptionalMessageList").mockImplementation(() => ({
    mcpAppOrigin: null, readOnly: false, workspaceId: "workspace", sessionId: "session",
    showThinking: false, developerMode: false, displaySuggestions: false,
    providerConnectedCount: 0, resolveReplyModelTitle: () => undefined,
    autoRoutes: [], resolveAutoRouteName: () => undefined, connectorIdentities: [],
    syncDegraded: reconnecting, dispatchAction: () => {}, setPrompt: () => {},
    onRevertToUserMessage: () => {}, onEditUserMessage: () => {},
    composerSubagentToolCallIds: new Set<string>(),
    onMcpReconnect: async () => { throw new Error("Unexpected reconnect"); },
    onMcpReopenAuthorization: async () => {},
  }));
  spyOn(previews, "BuiltAppChatPreview").mockImplementation(() => <button>Open</button>);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
  mock.restore();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function build(state: "input-streaming" | "input-available" = "input-streaming"): DynamicToolUIPart {
  return { type: "dynamic-tool", toolName: "create_app", toolCallId: "build", state, input: { title: "Revenue pulse" } };
}
function run(part = build()): AppCreationRun {
  return { id: "revenue", builds: [part] };
}
async function render(value: AppCreationRun, active = true, activity: string | null = null) {
  await act(async () => root.render(<QueryClientProvider client={client}><AppBuilderStep run={value} active={active} activity={activity} /></QueryClientProvider>));
}
async function toggleDetails() {
  const button = host.querySelector<HTMLButtonElement>("button[aria-expanded]");
  expect(button).not.toBeNull();
  await act(async () => button?.click());
}

test("named artifact stays one compact row through writing, building and gaps, with technical stages disclosed", async () => {
  await render(run(), true, "Writing source");
  const section = host.querySelector("[data-artifact-progress]");
  const rowClass = section?.firstElementChild?.className;
  expect(host.textContent).toContain("Revenue pulse");
  expect(host.textContent).toContain("Writing the artifact");
  expect(host.textContent).not.toContain("Writing source");
  expect(host.querySelector("[data-app-builder-checklist]")).toBeNull();
  expect(host.textContent).not.toContain("verified");
  await render(run(build("input-available")), true, null);
  expect(host.querySelector("[data-artifact-progress]")).toBe(section);
  expect(section?.firstElementChild?.className).toBe(rowClass);
  expect(host.querySelector("[data-app-builder-activity]")?.className).toContain("h-4");
  expect(host.textContent).toContain("Building the artifact");
  await toggleDetails();
  expect(host.querySelectorAll("[data-app-builder-checklist] li")).toHaveLength(5);
  expect(host.textContent).toContain("Building and verifying");
  await toggleDetails();
  expect(host.querySelector("[data-app-builder-checklist]")).toBeNull();
});

test("preparation reports only the current connection check, never verified data", async () => {
  const preparation: DynamicToolUIPart = { type: "dynamic-tool", toolName: "prepare_app", toolCallId: "prepare", state: "input-available", input: { title: "Revenue pulse" } };
  await render({ id: "revenue", preparation, builds: [] });
  expect(host.textContent).toContain("Revenue pulse");
  expect(host.textContent).toContain("Checking the connections");
  expect(host.textContent).not.toContain("verified");
  const denied: DynamicToolUIPart = { ...preparation, state: "output-denied" };
  await render({ id: "revenue", preparation: denied, builds: [] });
  expect(host.textContent).toContain("Permission was denied. Review details before retrying.");
  expect(host.textContent).not.toContain("Created artifact");
});

test("artifact progress is compact without a rollout setting", async () => {
  await render(run());
  expect(host.querySelector("[data-artifact-progress]")).not.toBeNull();
  expect(host.querySelector("[data-app-builder-checklist]")).toBeNull();
  expect(host.querySelector("section")?.className).not.toContain("rounded-xl border");
});

test("paused, waiting and reconnecting keep the artifact and actionable status", async () => {
  await render(run(), false);
  expect(host.textContent).toContain("Paused — send a message to continue");
  waiting = true;
  await render(run());
  expect(host.textContent).toContain("Waiting for your response — review the request in chat");
  reconnecting = true;
  await render(run());
  expect(host.textContent).toContain("Reconnecting — progress will resume when connected");
  expect(host.textContent).toContain("Revenue pulse");
});

test("build rejection remains visible with recovery direction and full error in details", async () => {
  const failed: DynamicToolUIPart = { ...build("input-available"), state: "output-error", errorText: "MCP App compilation failed. Generated MCP Apps cannot use timers. Use refresh instead." };
  await render(run(failed));
  expect(host.textContent).toContain("Can’t use timers. Review details before retrying.");
  expect(host.textContent).not.toContain("Created artifact");
  await toggleDetails();
  expect(host.textContent).toContain("Generated MCP Apps cannot use timers");
  expect(host.querySelector("[data-checklist-state=failed]")).not.toBeNull();
});

function completed(toolName = "create_app"): DynamicToolUIPart {
  const appId = `cob_0${"0".repeat(25)}`;
  const revisionId = `cov_0${"0".repeat(25)}`;
  const resourceUri = mcpAppResourceUri(appId, revisionId);
  return {
    ...build(), toolName, state: "output-available", output: "Ready",
    callProviderMetadata: { openwork: { mcpResult: {
      content: [{ type: "text", text: "Ready" }],
      structuredContent: { app: { appId, revisionId, pluginId: `plg_0${"0".repeat(25)}`, title: "Revenue pulse", description: null, textFallback: "Revenue pulse", toolName: "open_app", resourceUri, serverPath: "/mcp/app", tools: [] } },
      _meta: { "openwork/mcpApp": { connectionId: appId, toolName: "open_app", resourceUri, arguments: {} } },
    } } },
  };
}

test("success quietly names the created or updated artifact and retains Open and details", async () => {
  for (const [tool, verb] of [["create_app", "Created"], ["update_app", "Updated"]]) {
    await render(run(completed(tool)), false);
    expect(host.textContent).toContain(`${verb} artifact “Revenue pulse”`);
    expect(host.textContent).toContain("Open");
    expect(host.textContent).not.toContain("verified");
    expect(host.querySelector("[data-app-builder-checklist]")).toBeNull();
  }
  await toggleDetails();
  expect(host.textContent).toContain("Built and verified");
});

test("unavailable and unrecorded results never pretend a launch exists", async () => {
  await render(run({ ...build(), state: "output-available", output: "No launch recorded" }), false);
  expect(host.textContent).toContain("Couldn’t open the preview. Review details.");
  expect(host.textContent).not.toContain("Created artifact");
  expect(host.textContent).not.toContain("Open");
  await render(run({ ...build(), state: "output-available", output: "Unrecorded", callProviderMetadata: { openwork: { mcpResult: { structuredContent: { unrecorded: true } } } } }), false);
  expect(host.textContent).toContain("Created artifact “Revenue pulse”");
  expect(host.textContent).toContain("Open it from your Library");
});
