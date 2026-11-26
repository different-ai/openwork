import { expect, test } from "bun:test";
import type { PersonalAgentRequest } from "@openwork/types/den/personal-agents";

import { changeRequestLine } from "../src/react-app/domains/agents/agent-change-request";
import { resolveAgentChatSession } from "../src/react-app/domains/agents/agent-chat-session";
import { canChangeShare } from "../src/react-app/domains/agents/agent-share";
import { agentProposalKey } from "../src/react-app/domains/agents/agent-start";

test("an open local agent chat wins without reading Den or opening another chat", async () => {
  const result = await resolveAgentChatSession({
    localSessionId: "local",
    sessionState: async () => "open",
    readPointer: async () => { throw new Error("Unexpected Den lookup"); },
    createSession: async () => { throw new Error("Unexpected creation"); },
  });
  expect(result).toEqual({ sessionId: "local", source: "local" });
});

test("an open Den pointer wins over a gone local chat", async () => {
  const result = await resolveAgentChatSession({
    localSessionId: "gone",
    sessionState: async (id) => id === "den" ? "open" : "gone",
    readPointer: async () => "den",
    createSession: async () => { throw new Error("Unexpected creation"); },
  });
  expect(result).toEqual({ sessionId: "den", source: "den" });
});

test("no open binding means creating a new agent chat", async () => {
  const result = await resolveAgentChatSession({
    localSessionId: null,
    sessionState: async () => "unknown",
    readPointer: async () => "stale",
    createSession: async () => "fresh",
  });
  expect(result).toEqual({ sessionId: "fresh", source: "new" });
});

test("proposal idempotency keys are short, stable and distinguish both input ids", async () => {
  const session = "session".repeat(50);
  const call = "call".repeat(50);
  const key = await agentProposalKey(session, call);
  expect(key).toMatch(/^[a-z0-9-]{8,128}$/);
  expect(await agentProposalKey(session, call)).toBe(key);
  expect(await agentProposalKey(session + "2", call)).not.toBe(key);
  expect(await agentProposalKey(session, call + "2")).not.toBe(key);
  expect(await agentProposalKey("a:b", "c")).not.toBe(await agentProposalKey("a", "b:c"));
});

test("managers can add and remove collaborators but cannot grant or edit manager access", () => {
  expect(canChangeShare("manager", null, "collaborator")).toBe(true);
  expect(canChangeShare("manager", "collaborator", "collaborator")).toBe(true);
  expect(canChangeShare("manager", "collaborator", null)).toBe(true);
  expect(canChangeShare("manager", null, "manager")).toBe(false);
  expect(canChangeShare("manager", "collaborator", "manager")).toBe(false);
  expect(canChangeShare("manager", "manager", "collaborator")).toBe(false);
  expect(canChangeShare("manager", "manager", null)).toBe(false);
  expect(canChangeShare("manager", "owner", null)).toBe(false);
  expect(canChangeShare("owner", "manager", "collaborator")).toBe(true);
  expect(canChangeShare("owner", "owner", null)).toBe(false);
  expect(canChangeShare("collaborator", null, "collaborator")).toBe(false);
});

test("change requests name the person who asked, the owner to wait for, or the person who decided", () => {
  const request: Pick<PersonalAgentRequest, "status" | "summary" | "requestedBy" | "decidedBy" | "canDecide"> = {
    status: "pending",
    summary: "Run at 9 AM",
    requestedBy: { memberId: "priya", name: "Priya Nair" },
    decidedBy: null,
    canDecide: ["approve", "deny"],
  };
  expect(changeRequestLine(request, "Dana Reyes")).toBe("Priya asks: Run at 9 AM");
  expect(changeRequestLine({ ...request, canDecide: [] }, "Dana Reyes")).toBe("Waiting for Dana to approve: Run at 9 AM");
  const decidedBy = { memberId: "sam", name: "Sam Okafor" };
  expect(changeRequestLine({ ...request, status: "approved", decidedBy }, "Dana Reyes")).toBe("Sam Okafor approved: Run at 9 AM");
  expect(changeRequestLine({ ...request, status: "denied", decidedBy }, "Dana Reyes")).toBe("Sam Okafor said no: Run at 9 AM");
});
