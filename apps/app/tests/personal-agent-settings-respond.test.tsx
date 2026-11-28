import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { personalAgentDetailSchema, personalAgentRequestSchema, type PersonalAgentConnectionTools, type PersonalAgentTool, type UpdatePersonalAgent } from "@openwork/types/den/personal-agents";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";

import { createDenClient } from "../src/app/lib/den";
import type { AgentsRuntime } from "../src/react-app/domains/agents/agents-runtime";

const ownsDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
beforeAll(() => {
  if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

test("the switch and tool buttons answer at once while the tool list is still reloading", async () => {
  const { AgentSettings } = await import("../src/react-app/domains/agents/agent-settings");
  const { agentToolsKey } = await import("../src/react-app/domains/agents/use-agent-permissions");
  const { agentListKey } = await import("../src/react-app/domains/agents/use-agents");
  const timestamp = "2026-11-26T12:00:00.000Z";
  const detail = (toolPolicy: UpdatePersonalAgent["toolPolicy"]) => personalAgentDetailSchema.parse({
    agent: { id: "agent", organizationId: "org", ownerMemberId: "member", name: "Inbox helper", state: "active", currentRevisionId: "revision", createdAt: timestamp, updatedAt: timestamp, archivedAt: null },
    revision: { id: "revision", agentId: "agent", version: 1, brief: "Triage", toolPolicy, defaultExecutionTarget: "cloud", monthlyBudgetMicros: null, digest: "0123456789abcdef", createdAt: timestamp },
    routineCount: 0, routines: [],
  });
  const agent = detail({ tools: {}, connections: { openwork: "block" } });
  const tools: PersonalAgentTool[] = ["read", "write"].map((name) => ({ name, title: name, write: name === "write", access: "block", chosen: null, lockedByOrganization: false, organizationRule: null }));
  const connection: PersonalAgentConnectionTools = { connectionId: "openwork", name: "OpenWork", available: true, blocked: true, onlyChosenTools: false, lockedByOrganization: false, sharedLogin: null, canShareLogin: false, tools };
  const saved: UpdatePersonalAgent[] = [];
  const baseUrl = "https://den.example.test";
  const runtime: AgentsRuntime = {
    denBaseUrl: baseUrl, organizationId: "org", principal: "member", workspaceId: "workspace", selectedSessionId: "agent-chat",
    client: {
      ...createDenClient({ baseUrl }),
      getPersonalAgentTools: () => new Promise(() => {}),
      updatePersonalAgent: async (_organizationId, _agentId, change) => {
        saved.push(change);
        return detail(change.toolPolicy);
      },
    },
    createSession: async () => null, openSession: () => {}, sessionState: async () => "open", renameSession: () => {},
  };
  const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity } } });
  cache.setQueryData(agentListKey(runtime), [agent]);
  cache.setQueryData(agentToolsKey(runtime, "agent"), { connections: [connection] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = (await import("react-dom/client")).createRoot(container);
  await act(async () => root.render(<QueryClientProvider client={cache}><AgentSettings runtime={runtime} agent={agent} onBack={() => {}} /></QueryClientProvider>));
  const element = (selector: string) => {
    const found = container.querySelector(selector);
    if (!(found instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
    return found;
  };
  const settle = () => act(async () => { await Bun.sleep(20); });

  await act(async () => element("[data-agent-connection-switch]").click());
  expect(element("[data-agent-connection-switch]").getAttribute("aria-checked")).toBe("true");
  await settle();
  expect(saved).toEqual([{ toolPolicy: { tools: {}, connections: { openwork: "allow" } } }]);
  expect(cache.isFetching({ queryKey: agentToolsKey(runtime, "agent") })).toBe(1);

  await act(async () => element("[data-agent-connection-toggle]").click());
  expect(element('[data-agent-tool="read"] [data-agent-tool-access="allow"]').getAttribute("aria-pressed")).toBe("true");
  expect(element('[data-agent-tool="write"] [data-agent-tool-access="ask"]').getAttribute("aria-pressed")).toBe("true");
  await act(async () => element('[data-agent-tool="write"] [data-agent-tool-access="block"]').click());
  await settle();
  expect(element('[data-agent-tool="write"] [data-agent-tool-access="block"]').getAttribute("aria-pressed")).toBe("true");
  expect(saved[1]).toEqual({ toolPolicy: { tools: { openwork: { write: "block" } }, connections: { openwork: "allow" } } });

  await act(async () => element("[data-agent-connection-switch]").click());
  await settle();
  expect(element("[data-agent-connection-switch]").getAttribute("aria-checked")).toBe("false");
  await act(async () => element('[data-agent-tool="read"] [data-agent-tool-access="allow"]').click());
  await settle();
  expect(saved[2]).toEqual({ toolPolicy: { tools: { openwork: { write: "block" } }, connections: { openwork: "block" } } });
  expect(saved[3]).toEqual({ toolPolicy: { tools: { openwork: { write: "block", read: "allow" } }, connections: { openwork: "ask" } } });
  expect(element("[data-agent-connection-status]").textContent).toContain("1");
  await act(async () => root.unmount());
});

test("a request for a whole app offers choosing tools instead of only turning everything on", async () => {
  const { AgentToolDecision } = await import("../src/react-app/domains/agents/agent-tool-request");
  const timestamp = "2026-11-26T12:00:00.000Z";
  const agent = personalAgentDetailSchema.parse({
    agent: { id: "agent", organizationId: "org", ownerMemberId: "member", name: "Inbox helper", state: "active", currentRevisionId: "revision", createdAt: timestamp, updatedAt: timestamp, archivedAt: null },
    revision: { id: "revision", agentId: "agent", version: 1, brief: "Triage", toolPolicy: { tools: {}, connections: {} }, defaultExecutionTarget: "cloud", monthlyBudgetMicros: null, digest: "0123456789abcdef", createdAt: timestamp },
    routineCount: 0, routines: [],
  });
  const request = personalAgentRequestSchema.parse({
    id: "request", agentId: "agent", kind: "tool", status: "pending", requestedBy: { memberId: "member", name: "Ada Example" }, requestedByCaller: true,
    runId: null, connectionId: "openwork", connectionName: "OpenWork", toolName: null, toolTitle: null, summary: null, change: null,
    decidedBy: null, decidedAt: null, createdAt: timestamp, connectorAccess: true, canDecide: ["deny", "turn_on"],
  });
  const baseUrl = "https://den.example.test";
  const runtime: AgentsRuntime = {
    denBaseUrl: baseUrl, organizationId: "org", principal: "member", workspaceId: "workspace", selectedSessionId: "agent-chat",
    client: createDenClient({ baseUrl }),
    createSession: async () => null, openSession: () => {}, sessionState: async () => "open", renameSession: () => {},
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = (await import("react-dom/client")).createRoot(container);
  let chose = 0;
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}>
    <AgentToolDecision runtime={runtime} agent={agent} request={request} onChooseTools={() => { chose += 1; }} />
  </QueryClientProvider>));
  const choose = container.querySelector("[data-agent-ask-choose-tools]");
  if (!(choose instanceof HTMLElement)) throw new Error("Missing choose tools");
  expect(container.textContent).toContain("every tool");
  await act(async () => choose.click());
  expect(chose).toBe(1);
  await act(async () => root.unmount());
});
