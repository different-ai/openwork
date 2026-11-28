import { describe, expect, test } from "bun:test";
import type { PersonalAgentAccess, PersonalAgentTool, PersonalAgentToolPolicy } from "@openwork/types/den/personal-agents";

import { agentOwnerFirstName, agentSpendLine, formatAgentMoney, requestToolTitle, shouldRerunAfterToolDecision, toolAccessSummary, toolRequestReceipt, toolRequestRerunLine, toolRequestWaitingLine } from "../src/react-app/domains/agents/agent-permission-words";
import { nextAgentConnectionPolicy, nextAgentToolPolicy } from "../src/react-app/domains/agents/use-agent-permissions";

const dana = { memberId: "member-dana", name: "Dana Reyes" };

function tool(name: string, access: PersonalAgentAccess): PersonalAgentTool {
  return { name, title: name, access, write: false, chosen: null, lockedByOrganization: false };
}

describe("personal agent permissions", () => {
  test("changing one tool leaves other choices in place", () => {
    const before: PersonalAgentToolPolicy = {
      connections: { gmail: "block" },
      tools: { slack: { search: "allow", post: "ask" }, linear: { create: "block" } },
    };
    expect(nextAgentToolPolicy(before, { connectionId: "slack", toolName: "post", access: "allow" })).toEqual({
      connections: { gmail: "block" },
      tools: { slack: { search: "allow", post: "allow" }, linear: { create: "block" } },
    });
    expect(before.tools.slack?.post).toBe("ask");
  });

  test("choosing a default value still stores an explicit choice", () => {
    expect(nextAgentToolPolicy({ connections: {}, tools: {} }, { connectionId: "slack", toolName: "search", access: "allow" }))
      .toEqual({ connections: {}, tools: { slack: { search: "allow" } } });
  });

  test("switching a connection overrides the default without changing per-tool choices", () => {
    const before: PersonalAgentToolPolicy = {
      connections: { "*": "block", gmail: "allow" },
      tools: { slack: { search: "allow", post: "ask", delete: "block" } },
    };
    const on = nextAgentConnectionPolicy(before, { connectionId: "slack", enabled: true });
    expect(on.connections).toEqual({ "*": "block", gmail: "allow", slack: "allow" });
    const off = nextAgentConnectionPolicy(on, { connectionId: "slack", enabled: false });
    expect(off.connections).toEqual({ "*": "block", gmail: "allow", slack: "block" });
    expect(off.tools).toEqual(before.tools);
  });

  test("picking a tool on a connection that is off gives the agent only that tool", () => {
    const before = { connections: { slack: "block" as const }, tools: { slack: { search: "allow" as const, remove: "block" as const }, linear: { list: "allow" as const } } };
    const one = nextAgentToolPolicy(before, { connectionId: "slack", toolName: "post", access: "ask", connectionOff: true });
    expect(one).toEqual({ connections: { slack: "ask" }, tools: { slack: { remove: "block", post: "ask" }, linear: { list: "allow" } } });
    const two = nextAgentToolPolicy(one, { connectionId: "slack", toolName: "search", access: "allow", connectionOff: true });
    expect(two.tools.slack).toEqual({ remove: "block", post: "ask", search: "allow" });
    const none = nextAgentToolPolicy(nextAgentToolPolicy(two, { connectionId: "slack", toolName: "post", access: "block", connectionOff: true }),
      { connectionId: "slack", toolName: "search", access: "block", connectionOff: true });
    expect(none.connections.slack).toBe("block");
    expect(nextAgentToolPolicy(before, { connectionId: "slack", toolName: "post", access: "block", connectionOff: true }).connections.slack).toBe("block");
    expect(nextAgentConnectionPolicy(two, { connectionId: "slack", enabled: true }).connections.slack).toBe("allow");
  });

  test("a connection that is off apart from picked tools says how many", () => {
    const tools = [{ ...tool("search", "allow"), chosen: "allow" as const }, { ...tool("post", "ask"), chosen: "ask" as const }, { ...tool("remove", "block"), chosen: "block" as const }, tool("list", "block")];
    expect(toolAccessSummary({ available: true, blocked: true, onlyChosenTools: true, lockedByOrganization: false, tools })).toBe("Off, apart from 2 tools you picked");
    expect(toolAccessSummary({ available: true, blocked: true, onlyChosenTools: true, lockedByOrganization: false, tools: tools.slice(0, 1) })).toBe("Off, apart from 1 tool you picked");
  });

  test("summarizes effective access only for enabled, available connections", () => {
    const tools = [tool("search", "allow"), tool("list", "allow"), tool("get", "allow"), tool("post", "ask"), tool("reply", "ask"), tool("delete", "block")];
    expect(toolAccessSummary({ available: true, blocked: false, lockedByOrganization: false, tools })).toBe("3 allowed · 2 ask · 1 blocked");
    expect(toolAccessSummary({ available: true, blocked: false, lockedByOrganization: false, tools: [] })).toBe("0 allowed · 0 ask · 0 blocked");
    expect(toolAccessSummary({ available: false, blocked: false, lockedByOrganization: false, tools: [] })).toBe("Not connected");
    expect(toolAccessSummary({ available: true, blocked: true, lockedByOrganization: false, tools })).toBe("Off");
    expect(toolAccessSummary({ available: false, blocked: true, lockedByOrganization: true, tools: [] })).toBe("Blocked by your admin");
  });

  test("names the decider and describes each tool request outcome", () => {
    const request = { toolTitle: "Post a message", toolName: "post_message", decidedBy: dana };
    expect(agentOwnerFirstName(dana)).toBe("Dana");
    expect(requestToolTitle({ ...request, toolTitle: null })).toBe("Post message");
    expect(requestToolTitle({ toolTitle: "slack.post_message", toolName: "slack.post_message" })).toBe("Post message");
    expect(toolRequestReceipt({ ...request, status: "denied" }, "Bug watcher")).toBe("Dana Reyes said no, so Bug watcher didn't use Post a message");
    expect(toolRequestReceipt({ ...request, status: "denied" }, "Bug watcher", true)).toBe("You said no, so Bug watcher didn't use Post a message");
    expect(toolRequestReceipt({ ...request, status: "denied", decidedBy: null }, "Bug watcher")).toBe("You said no, so Bug watcher didn't use Post a message");
    expect(toolRequestReceipt({ ...request, status: "allowed_once" }, "Bug watcher")).toBe("Bug watcher can use Post a message this time");
    expect(toolRequestReceipt({ ...request, status: "used" }, "Bug watcher")).toBe("Bug watcher can use Post a message this time");
    expect(toolRequestReceipt({ ...request, status: "always_allowed" }, "Bug watcher")).toBe("Bug watcher can use Post a message from now on");
    expect(toolRequestReceipt({ ...request, status: "pending" }, "Bug watcher")).toBeNull();
  });

  test("a pending tool request with no permitted decisions shows the waiting line regardless of role", () => {
    const request = { status: "pending", toolTitle: "Post a message", toolName: "post_message", connectionName: "Slack" } as const;
    expect(toolRequestWaitingLine({ ...request, canDecide: [] }, dana)).toBe("Waiting for Dana to answer: Post a message in Slack");
    expect(toolRequestWaitingLine({ ...request, canDecide: ["deny", "allow_once"] }, dana)).toBeNull();
    expect(toolRequestWaitingLine({ ...request, status: "denied", canDecide: [] }, dana)).toBeNull();
  });

  test("only allowing your own request starts another run", () => {
    expect(shouldRerunAfterToolDecision({ requestedByCaller: true }, "allow_once")).toBe(true);
    expect(shouldRerunAfterToolDecision({ requestedByCaller: true }, "always_allow")).toBe(true);
    expect(shouldRerunAfterToolDecision({ requestedByCaller: true }, "deny")).toBe(false);
    expect(shouldRerunAfterToolDecision({ requestedByCaller: false }, "allow_once")).toBe(false);
    expect(shouldRerunAfterToolDecision({ requestedByCaller: false }, "always_allow")).toBe(false);
  });

  test("an approval for someone else names the requester without claiming a run started", () => {
    const request = { requestedByCaller: false, requestedBy: { memberId: "member-priya", name: "Priya Nair" } };
    expect(toolRequestRerunLine({ ...request, status: "allowed_once" })).toBe("Priya can run it again now.");
    expect(toolRequestRerunLine({ ...request, status: "always_allowed" })).toBe("Priya can run it again now.");
    expect(toolRequestRerunLine({ ...request, status: "allowed_once", requestedByCaller: true })).toBeNull();
    expect(toolRequestRerunLine({ ...request, status: "denied" })).toBeNull();
    expect(toolRequestRerunLine({ ...request, status: "used" })).toBeNull();
  });

  test("formats micros as dollars and distinguishes no budget from zero budget", () => {
    expect(formatAgentMoney(420_000)).toBe("$0.42");
    expect(formatAgentMoney(10_000_000)).toBe("$10.00");
    expect(agentSpendLine({ monthMicros: 420_000, budgetMicros: 10_000_000 })).toBe("$0.42 of $10.00 this month");
    expect(agentSpendLine({ monthMicros: 420_000, budgetMicros: null })).toBe("$0.42 this month");
    expect(agentSpendLine({ monthMicros: 0, budgetMicros: 0 })).toBe("$0.00 of $0.00 this month");
  });
});
