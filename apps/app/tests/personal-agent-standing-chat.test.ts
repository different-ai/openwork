import { expect, test } from "bun:test";

import { createDenClient } from "../src/app/lib/den";

import { standingChatFeature, standingChatMode, standingChatSessionId, type StandingChatFeature } from "../src/react-app/domains/agents/agent-chat-mode";
import { agentChatKey, type AgentChat } from "../src/react-app/domains/agents/agent-chat-store";

const scope = { denBaseUrl: "https://den.example.test", organizationId: "org", principal: "member" };
const chat: AgentChat = {
  ...scope, sessionId: "draft", workspaceId: "workspace", agentId: null, agentName: null, proposalId: null,
  asked: true, createdAt: 1, routineId: null, routineName: null, firstRunId: null,
};

const chats = (binding: AgentChat) => ({ [agentChatKey(scope, binding.sessionId)]: binding });

test("only the existing personalAgents flag enables standing chat", () => {
  expect(standingChatFeature({ personalAgents: true })).toBe("enabled");
  expect(standingChatFeature({ personalAgents: false })).toBe("disabled");
  expect(standingChatFeature({ personalAgentConnectorControls: true })).toBe("unknown");
  expect(standingChatFeature(undefined)).toBe("unknown");
});

test("ordinary sessions and incomplete agent drafts keep the workspace composer", () => {
  const featureStates: StandingChatFeature[] = ["enabled", "disabled", "unknown"];
  for (const feature of featureStates) {
    expect(standingChatMode(chats(chat), scope, "ordinary", feature)).toBe("workspace");
    expect(standingChatMode(chats(chat), scope, chat.sessionId, feature)).toBe("workspace");
    expect(standingChatMode(chats({ ...chat, agentId: "agent", proposalId: "proposal" }), scope, chat.sessionId, feature)).toBe("workspace");
  }
});

test("standing chats never fall through to workspace execution, including identity and feature outages", () => {
  const standing = { ...chat, agentId: "agent", proposalId: "proposal", routineId: "routine" };
  expect(standingChatMode(chats(standing), scope, standing.sessionId, "enabled")).toBe("scoped");
  expect(standingChatMode(chats(standing), scope, standing.sessionId, "disabled")).toBe("locked");
  expect(standingChatMode(chats(standing), scope, standing.sessionId, "unknown")).toBe("locked");
  expect(standingChatMode(chats(standing), null, standing.sessionId, "enabled")).toBe("locked");
  expect(standingChatMode(chats(standing), { ...scope, principal: "someone-else" }, standing.sessionId, "enabled")).toBe("locked");
  expect(standingChatMode({}, scope, standingChatSessionId("agent"), "enabled")).toBe("locked");
});

test("reading and sending use only the authenticated Den standing-chat endpoint", async () => {
  const input = { clientMessageId: "client-key", message: "What changed?" };
  const turn = { ...input, id: "turn", status: "running", reply: null, error: null, createdAt: "2026-11-26T13:00:00Z", finishedAt: null };
  const requests: Array<{ path: string; method: string; organizationId: string | null; authorization: string | null; body: unknown }> = [];
  let fail = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push({ path: new URL(request.url).pathname, method: request.method,
      organizationId: request.headers.get("x-openwork-org-id"), authorization: request.headers.get("authorization"),
      body: request.method === "POST" ? await request.json() : null });
    if (fail) return Response.json({ error: "request_failed" }, { status: 503 });
    return request.method === "GET" ? Response.json({ turns: [] }) : Response.json({ turn }, { status: 202 });
  } });
  try {
    const client = createDenClient({ baseUrl: server.url.origin, token: "test-token" });
    expect(await client.getPersonalAgentThread("org", "agent/id")).toEqual({ turns: [] });
    expect(await client.sendPersonalAgentThreadMessage("org", "agent/id", input)).toEqual({ turn });
    fail = true;
    await expect(client.sendPersonalAgentThreadMessage("org", "agent/id", input)).rejects.toThrow();
    expect(requests).toEqual([
      { path: "/api/den/v1/personal-agents/agent%2Fid/standing-chat", method: "GET", organizationId: "org", authorization: "Bearer test-token", body: null },
      ...Array.from({ length: 2 }, () => ({ path: "/api/den/v1/personal-agents/agent%2Fid/standing-chat", method: "POST", organizationId: "org", authorization: "Bearer test-token", body: input })),
    ]);
  } finally {
    server.stop(true);
  }
});
