import { expect, test } from "bun:test";
import { personalAgentDetailSchema, personalAgentRequestSchema, type PersonalAgentToolPolicy } from "@openwork/types/den/personal-agents";

import { isBeingChosen } from "../src/react-app/domains/agents/agent-chat-dock";
import { newAgentName } from "../src/react-app/domains/agents/agent-sidebar-section";

const timestamp = "2026-11-26T12:00:00.000Z";

function agentWith(toolPolicy: PersonalAgentToolPolicy) {
  return personalAgentDetailSchema.parse({
    agent: { id: "agent", organizationId: "org", ownerMemberId: "member", name: "Inbox helper", state: "active", currentRevisionId: "revision", createdAt: timestamp, updatedAt: timestamp, archivedAt: null },
    revision: { id: "revision", agentId: "agent", version: 1, brief: "Triage", toolPolicy, defaultExecutionTarget: "cloud", monthlyBudgetMicros: null, digest: "0123456789abcdef", createdAt: timestamp },
    routineCount: 0, routines: [],
  });
}

function ask(toolName: string | null) {
  return personalAgentRequestSchema.parse({
    id: "request", agentId: "agent", kind: "tool", status: "pending", requestedBy: { memberId: "member", name: "Ada Example" }, requestedByCaller: true,
    runId: null, connectionId: "openwork", connectionName: "OpenWork", toolName, toolTitle: toolName, summary: null, change: null,
    decidedBy: null, decidedAt: null, createdAt: timestamp, ...(toolName === null ? { connectorAccess: true } : {}), canDecide: toolName === null ? ["deny", "turn_on"] : ["deny", "allow_once"],
  });
}

test("a new agent gets the first free name", () => {
  expect(newAgentName([])).toBe("New agent");
  expect(newAgentName(["New agent", "Bug triage"])).toBe("New agent 2");
  expect(newAgentName(["New agent", "New agent 2"])).toBe("New agent 3");
});

test("the ask for a whole app leaves the composer while its tools are being chosen, and for good once one is picked", () => {
  const untouched = agentWith({ tools: {}, connections: {} });
  expect(isBeingChosen(untouched, ask(null), false)).toBe(false);
  expect(isBeingChosen(untouched, ask(null), true)).toBe(true);
  expect(isBeingChosen(agentWith({ tools: { openwork: { read: "allow" } }, connections: { openwork: "ask" } }), ask(null), false)).toBe(true);
  expect(isBeingChosen(untouched, ask("write"), true)).toBe(false);
});
