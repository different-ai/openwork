import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { personalAgentDetailSchema } from "@openwork/types/den/personal-agents";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { MemoryRouter } from "react-router";

import type { AgentsRuntime } from "../src/react-app/domains/agents/agents-runtime";
import type { SessionPageProps } from "../src/react-app/domains/session/chat/session-page";

const ownsDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");

beforeAll(() => {
  if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/", width: 1440, height: 900 });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownsDom) await GlobalRegistrator.unregister();
});

const workspace = { id: "workspace", name: "Sam’s workspace", path: "/fixture/workspace", preset: "starter", workspaceType: "local" } satisfies SessionPageProps["workspaces"][number];
const agentSession = { id: "agent-chat", title: "Agent conversation" };
const ordinarySession = { id: "ordinary-chat", title: "Weekly notes" };
const noop = () => {};

function sessionPageProps(sessionId: string): SessionPageProps {
  return {
    selectedSessionId: sessionId,
    selectedWorkspaceId: workspace.id,
    selectedWorkspaceDisplay: workspace,
    selectedWorkspaceRoot: workspace.path,
    runtimeWorkspaceId: null,
    workspaces: [workspace],
    clientConnected: true,
    openworkServerStatus: "connected",
    openworkServerClient: null,
    developerMode: false,
    headerStatus: "",
    busyHint: null,
    startupPhase: "ready",
    providerConnectedIds: [],
    mcpConnectedCount: 0,
    todos: [],
    sessionLoadingById: () => false,
    runtimeSessionStatusById: {},
    sessionNumberShortcuts: { modifierHeld: false, os: "macos", targets: [] },
    onSendFeedback: noop,
    onOpenSettings: noop,
    onOpenExtensions: noop,
    sidebar: {
      selectedWorkspaceId: workspace.id,
      selectedSessionId: sessionId,
      workspaceSessionGroups: [{ workspace, sessions: [agentSession, ordinarySession], status: "ready" }],
      developerMode: false,
      sessionStatusById: {},
      connectingWorkspaceId: null,
      workspaceConnectionStateById: {},
      newTaskDisabled: false,
      sidebarHydratedFromCache: true,
      startupPhase: "ready",
      onSelectWorkspace: noop,
      onOpenSession: noop,
      onCreateTaskInWorkspace: noop,
      onCreateSplitTaskInWorkspace: noop,
      onOpenRenameWorkspace: noop,
      onRevealWorkspace: noop,
      onRetryWorkspace: noop,
      onForgetWorkspace: noop,
      onOpenCreateWorkspace: noop,
    },
  };
}

test("Sam can open an agent’s details from the compact chat header without replacing the ordinary chat breadcrumb", async () => {
  const { createRoot } = await import("react-dom/client");
  const { createDenClient } = await import("../src/app/lib/den");
  const { useAgentChatStore } = await import("../src/react-app/domains/agents/agent-chat-store");
  const { usePersonalAgentSessionExtensions } = await import("../src/react-app/domains/agents/agents-extension");
  const { PersonalAgentsProvider } = await import("../src/react-app/domains/agents/agents-runtime");
  const { agentToolsKey } = await import("../src/react-app/domains/agents/use-agent-permissions");
  const { agentListKey } = await import("../src/react-app/domains/agents/use-agents");
  const { DesktopConfigProvider } = await import("../src/react-app/domains/cloud/desktop-config-provider");
  const { SessionPage } = await import("../src/react-app/domains/session/chat/session-page");
  const { DenAuthContext } = await import("../src/react-app/kernel/den-auth-context");
  const { createDefaultPlatform, PlatformProvider } = await import("../src/react-app/kernel/platform");
  const { SessionExtensionsProvider } = await import("../src/react-app/kernel/session-extensions");
  const { BootStateProvider } = await import("../src/react-app/shell/boot-state");
  const { ShellConfigProvider } = await import("../src/react-app/shell/shell-config");

  const timestamp = "2026-11-26T12:00:00.000Z";
  const detail = personalAgentDetailSchema.parse({
    agent: { id: "agent", organizationId: "org", ownerMemberId: "sam", name: "Inbox helper", state: "active", currentRevisionId: "revision", createdAt: timestamp, updatedAt: timestamp, archivedAt: null },
    revision: { id: "revision", agentId: "agent", version: 1, brief: "Triage messages", toolPolicy: { tools: {}, connections: {} }, defaultExecutionTarget: "cloud", monthlyBudgetMicros: null, digest: "0123456789abcdef", createdAt: timestamp },
    routineCount: 1,
    routines: [{ id: "routine", name: "Check messages", state: "active", schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 }, nextDueAt: null, latestRun: null }],
  });
  const baseUrl = "https://den.example.test";
  const runtime: AgentsRuntime = {
    denBaseUrl: baseUrl, organizationId: "org", principal: "sam", workspaceId: workspace.id,
    selectedSessionId: agentSession.id,
    client: {
      ...createDenClient({ baseUrl }),
      listPersonalAgents: async () => ({ items: [detail], nextCursor: null }),
      getPersonalAgentTools: async () => ({ connections: [] }),
      getPersonalAgentMemory: async () => ({ notes: "", version: 0, updatedAt: null, updatedBy: null, canEdit: true, routines: [] }),
    },
    createSession: async () => null, openSession: noop, sessionState: async () => "open", renameSession: noop,
  };
  const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } } });
  cache.setQueryData(agentListKey(runtime), [detail]);
  cache.setQueryData(agentToolsKey(runtime, detail.agent.id), { connections: [] });
  const originalElectron = Object.getOwnPropertyDescriptor(window, "__OPENWORK_ELECTRON__");
  Object.defineProperty(window, "__OPENWORK_ELECTRON__", { value: {}, configurable: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const platform = createDefaultPlatform();
  const originalChatState = useAgentChatStore.getState();

  function Chat({ runtime }: { runtime: AgentsRuntime & { selectedSessionId: string } }) {
    const extensions = usePersonalAgentSessionExtensions(runtime, "enabled", () => null);
    return <SessionExtensionsProvider value={extensions}><SessionPage {...sessionPageProps(runtime.selectedSessionId)} /></SessionExtensionsProvider>;
  }

  const render = (sessionId: string) => act(async () => {
    const activeRuntime = { ...runtime, selectedSessionId: sessionId };
    root.render(
      <QueryClientProvider client={cache}>
        <BootStateProvider>
          <ShellConfigProvider>
            <PlatformProvider value={platform}>
              <DenAuthContext.Provider value={{ status: "checking", isSignedIn: false, user: null, verifiedIdentity: null, error: null, refresh: async () => {} }}>
                <DesktopConfigProvider>
                  <MemoryRouter>
                    <PersonalAgentsProvider value={activeRuntime}>
                      <Chat runtime={activeRuntime} />
                    </PersonalAgentsProvider>
                  </MemoryRouter>
                </DesktopConfigProvider>
              </DenAuthContext.Provider>
            </PlatformProvider>
          </ShellConfigProvider>
        </BootStateProvider>
      </QueryClientProvider>,
    );
  });

  const panel = () => container.querySelector('[data-agent-panel="agent"]');
  try {
    useAgentChatStore.getState().open({ ...runtime, sessionId: agentSession.id, agentId: detail.agent.id });
    await render(ordinarySession.id);
    const breadcrumb = container.querySelector('[data-session-header] nav[aria-label="Breadcrumb"]');
    expect(breadcrumb?.textContent).toContain(workspace.name);
    expect(breadcrumb?.querySelector("[data-session-header-title]")?.textContent).toBe(ordinarySession.title);
    expect(container.querySelector("[data-session-header] [data-agent-header]")).toBeNull();
    expect(panel()).toBeNull();

    await render(agentSession.id);
    const trigger = container.querySelector<HTMLButtonElement>('[data-session-header] button[aria-label="Open Inbox helper"]');
    expect(trigger?.dataset.agentHeader).toBe(detail.agent.id);
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    const agentBreadcrumb = trigger?.closest("nav");
    expect(agentBreadcrumb?.textContent).toContain("Agents");
    expect(agentBreadcrumb?.querySelector('[role="img"][aria-label="Runs in OpenWork Cloud"] svg.lucide-cloud')).not.toBeNull();
    expect(container.querySelector("[data-session-header] [data-agent-can-use]")).toBeNull();
    expect(panel()).toBeNull();
    await act(async () => trigger?.click());
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(panel()?.getAttribute("aria-label")).toBe("Inbox helper");
    expect(panel()?.id).toBe(trigger?.getAttribute("aria-controls"));
    expect(panel()?.textContent).toContain("Check messages");
    await act(async () => trigger?.click());
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(panel()).toBeNull();
  } finally {
    await act(async () => root.unmount());
    cache.clear();
    container.remove();
    useAgentChatStore.setState(originalChatState, true);
    if (originalElectron) Object.defineProperty(window, "__OPENWORK_ELECTRON__", originalElectron);
    else Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__");
  }
});
