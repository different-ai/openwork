import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { personalAgentDetailSchema, type PersonalAgentConnectionTools } from "@openwork/types/den/personal-agents";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";

import { createDenClient, DenApiError } from "../src/app/lib/den";
import { PersonalAgentsProvider, type AgentsRuntime } from "../src/react-app/domains/agents/agents-runtime";

function connection(name: string, overrides: Partial<PersonalAgentConnectionTools> = {}): PersonalAgentConnectionTools {
  return { connectionId: name, name, available: true, blocked: false, lockedByOrganization: false,
    sharedLogin: null, canShareLogin: false,
    tools: [{ name: "read", title: "Read", write: false, access: "ask", chosen: null, lockedByOrganization: false, organizationRule: null }],
    ...overrides };
}

const unavailable = [connection("Not connected", { available: false }), connection("Turned off", { blocked: true }),
  connection("Admin blocked", { lockedByOrganization: true }), connection("No tools", { tools: [] }),
  connection("Restricted", { tools: connection("Restricted").tools.map((tool) => ({ ...tool, access: "block" })) })];

const ownsDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
let root: Root | null = null;
let agentCanUseSummary: typeof import("../src/react-app/domains/agents/agent-can-use")["agentCanUseSummary"];
let useAgentChatStore: typeof import("../src/react-app/domains/agents/agent-chat-store")["useAgentChatStore"];
let AgentHeaderTitle: typeof import("../src/react-app/domains/agents/agent-header")["AgentHeaderTitle"];
let AgentPanel: typeof import("../src/react-app/domains/agents/agent-panel")["AgentPanel"];
let agentToolsKey: typeof import("../src/react-app/domains/agents/use-agent-permissions")["agentToolsKey"];
let agentListKey: typeof import("../src/react-app/domains/agents/use-agents")["agentListKey"];
beforeAll(async () => {
  if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  agentCanUseSummary = (await import("../src/react-app/domains/agents/agent-can-use")).agentCanUseSummary;
  useAgentChatStore = (await import("../src/react-app/domains/agents/agent-chat-store")).useAgentChatStore;
  AgentHeaderTitle = (await import("../src/react-app/domains/agents/agent-header")).AgentHeaderTitle;
  AgentPanel = (await import("../src/react-app/domains/agents/agent-panel")).AgentPanel;
  agentToolsKey = (await import("../src/react-app/domains/agents/use-agent-permissions")).agentToolsKey;
  agentListKey = (await import("../src/react-app/domains/agents/use-agents")).agentListKey;
});
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  useAgentChatStore.setState({ chats: {}, panel: null });
});

test("names apps that are usable, including those that ask first, and keeps the list short", () => {
  const summary = agentCanUseSummary({ connections: [...unavailable, connection("Slack"), connection("Linear"), connection("Calendar")] });
  expect(summary).toBe("Slack, Linear +1");
});

test("names an app that is off apart from the tools its owner picked", () => {
  expect(agentCanUseSummary({ connections: [connection("Turned off", { blocked: true }), connection("Notion", { blocked: true, onlyChosenTools: true })] })).toBe("Notion");
});

test("does not confuse an empty catalog with loading or an unavailable catalog", () => {
  expect(agentCanUseSummary({ connections: unavailable })).toBe("No apps yet. It’ll ask when it needs one.");
  expect(agentCanUseSummary(undefined)).toBeNull();
  expect(agentCanUseSummary(undefined, true)).toBe("Couldn’t check apps");
});

test.each([false, true])("only the panel says what the agent can use, and it opens What it can use (compact: %s)", async (compact) => {
  const timestamp = "2026-11-26T12:00:00.000Z";
  const agent = personalAgentDetailSchema.parse({
    agent: { id: "agent", organizationId: "org", ownerMemberId: "member", name: "Inbox helper", state: "active", currentRevisionId: "revision", createdAt: timestamp, updatedAt: timestamp, archivedAt: null },
    revision: { id: "revision", agentId: "agent", version: 1, brief: "Triage messages", toolPolicy: { tools: {}, connections: {} }, defaultExecutionTarget: "cloud", monthlyBudgetMicros: null, digest: "0123456789abcdef", createdAt: timestamp },
    routineCount: 1,
    routines: [{ id: "routine", name: "Check messages", state: "active", schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 }, nextDueAt: null, latestRun: null }],
  });
  const runCalls: Array<{ organizationId: string; agentId: string; routineId: string | undefined }> = [];
  const baseUrl = "https://den.example.test";
  const runtime: AgentsRuntime = {
    denBaseUrl: baseUrl, organizationId: "org", principal: "member", workspaceId: "workspace", selectedSessionId: "agent-chat",
    client: { ...createDenClient({ baseUrl }), getPersonalAgentTools: async () => ({ connections: [] }),
      getPersonalAgentMemory: async () => ({ notes: "", version: 0, updatedAt: null, updatedBy: null, canEdit: true, routines: [] }),
      runPersonalAgentNow: async (organizationId, agentId, input) => {
        runCalls.push({ organizationId, agentId, routineId: input.routineId });
        throw new DenApiError(409, "personal_agent_run_queue_full", "Queue full");
      } },
    createSession: async () => null, openSession: () => {}, sessionState: async () => "open", renameSession: () => {},
  };
  const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity } } });
  cache.setQueryData(agentListKey(runtime), [agent]);
  cache.setQueryData(agentToolsKey(runtime, agent.agent.id), { connections: [] });
  const container = document.createElement("div");
  document.body.append(container);
  root = (await import("react-dom/client")).createRoot(container);
  useAgentChatStore.getState().open({ ...runtime, sessionId: "agent-chat", agentId: agent.agent.id });
  await act(async () => root?.render(
    <QueryClientProvider client={cache}>
      <PersonalAgentsProvider value={runtime}>
        <AgentHeaderTitle sessionId="agent-chat">Regular chat</AgentHeaderTitle>
        <AgentPanel sessionId="agent-chat" compact={compact} />
      </PersonalAgentsProvider>
    </QueryClientProvider>,
  ));
  const element = (selector: string) => {
    const found = container.querySelector(selector) ?? document.body.querySelector(selector);
    if (!(found instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
    return found;
  };
  const click = async (selector: string) => { await act(async () => element(selector).click()); };
  const panelSummary = '[data-agent-can-use="panel"]';
  expect(container.querySelector("[data-agent-can-use]")).toBeNull();
  expect(container.querySelector("[data-agent-panel]")).toBeNull();
  await click('[data-agent-header="agent"]');
  expect(element("[data-agent-panel]").getAttribute("role")).toBe(compact ? "dialog" : null);
  expect(element(panelSummary).textContent).toContain("It’ll ask when it needs one.");
  expect(element(panelSummary).getAttribute("aria-label")).toBe("What it can use");
  await click("[data-agent-run-now]");
  await act(async () => { await Bun.sleep(20); });
  expect(runCalls).toEqual([{ organizationId: "org", agentId: "agent", routineId: "routine" }]);
  expect(element("[data-agent-panel] [role='status']").textContent).toContain("several runs waiting");
  await click(panelSummary);
  expect(element("[data-agent-settings] h3").textContent).toBe("What it can use");
});
