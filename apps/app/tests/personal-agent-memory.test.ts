import { expect, test } from "bun:test";

import { DenApiError } from "../src/app/lib/den";
import { agentChangeDetails } from "../src/react-app/domains/agents/agent-change-request";
import { agentMemoryUpdatedLine, isAgentMemoryConflict } from "../src/react-app/domains/agents/agent-memory";
import { agentMemoryKey } from "../src/react-app/domains/agents/use-agents";

test("memory is isolated by agent, server, organization, and caller", () => {
  const scope = { denBaseUrl: "https://den.acme.test", organizationId: "org", principal: "dana" };
  const key = agentMemoryKey(scope, "one");
  expect(key).not.toEqual(agentMemoryKey(scope, "two"));
  expect(key).not.toEqual(agentMemoryKey({ ...scope, principal: "priya" }, "one"));
  expect(key).not.toEqual(agentMemoryKey({ ...scope, organizationId: "other" }, "one"));
  expect(key).not.toEqual(agentMemoryKey({ ...scope, denBaseUrl: "https://den2.acme.test" }, "one"));
});

test("memory distinguishes a person, the agent, and no prior writer", () => {
  const now = 2 * 60 * 60 * 1000;
  expect(agentMemoryUpdatedLine({ updatedAt: 0, updatedBy: { memberId: "dana", name: "Dana Reyes" } }, now)).toBe("Updated by Dana Reyes, 2 hours ago");
  expect(agentMemoryUpdatedLine({ updatedAt: 0, updatedBy: null }, now)).toBe("Updated by the agent, 2 hours ago");
  expect(agentMemoryUpdatedLine({ updatedAt: null, updatedBy: null }, now)).toBeNull();
});

test("only the Den memory version conflict triggers the reload state", () => {
  expect(isAgentMemoryConflict(new DenApiError(409, "personal_agent_memory_conflict", "Conflict"))).toBe(true);
  expect(isAgentMemoryConflict(new DenApiError(409, "personal_agent_memory_full", "Full"))).toBe(false);
  expect(isAgentMemoryConflict(new DenApiError(500, "personal_agent_memory_conflict", "Error"))).toBe(false);
});

test("a memory change request includes the full note", () => {
  const memoryNote = `${"Group by priority.\n".repeat(20)}Keep the last group.`;
  expect(agentChangeDetails({ memoryNote })).toEqual({ rows: [{ key: "memory", block: "memory", text: memoryNote }], tools: null });
});
