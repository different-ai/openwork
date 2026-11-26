import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { agentChatFor, agentChatForAgent, agentChatKey, agentChatsInScope, type AgentChat } from "../src/react-app/domains/agents/agent-chat-store";
import { standingNote } from "../src/react-app/domains/agents/agent-prompt-note";
import { agentListKey, agentRequestsKey, agentsQueryRoot } from "../src/react-app/domains/agents/use-agents";
import { agentToolsKey } from "../src/react-app/domains/agents/use-agent-permissions";

const dana = { denBaseUrl: "https://den.acme.test", organizationId: "org", principal: "dana" };
const priya = { ...dana, principal: "priya" };
const danaChat: AgentChat = {
  ...dana,
  workspaceId: "workspace",
  sessionId: "chat",
  agentId: "bug-watcher",
  agentName: "Bug watcher",
  proposalId: null,
  routineId: "routine",
  routineName: "Check #bugs",
  firstRunId: null,
  asked: true,
  createdAt: 1,
};

describe("personal agent account isolation", () => {
  test("query keys partition cached lists, requests and tools by account, organization and server", () => {
    const cache = new QueryClient();
    for (const key of [agentListKey, (scope: typeof dana) => agentRequestsKey(scope, "bug-watcher"), (scope: typeof dana) => agentToolsKey(scope, "bug-watcher")]) {
      cache.setQueryData(key(dana), "Dana's data");
      expect(key(dana).slice(0, agentsQueryRoot(dana).length)).toEqual(agentsQueryRoot(dana));
      expect(cache.getQueryData(key(dana))).toBe("Dana's data");
      expect(cache.getQueryData(key(priya))).toBeUndefined();
      expect(cache.getQueryData(key({ ...dana, organizationId: "other-org" }))).toBeUndefined();
      expect(cache.getQueryData(key({ ...dana, denBaseUrl: "https://den2.acme.test" }))).toBeUndefined();
    }
    cache.clear();
  });

  test("chat, roster and hidden-session lookups cannot see another account's bindings", () => {
    const chats = { [agentChatKey(dana, "chat")]: danaChat };
    expect(agentChatFor(chats, dana, "chat")).toEqual(danaChat);
    expect(agentChatFor(chats, null, "chat")).toBeNull();
    expect(agentChatFor(chats, priya, "chat")).toBeNull();
    expect(agentChatForAgent(chats, priya, "workspace", "bug-watcher")).toBeNull();
    expect(agentChatsInScope(chats, priya)).toEqual([]);
    expect(agentChatsInScope(chats, { ...dana, denBaseUrl: "https://den2.acme.test" })).toEqual([]);
    const priyaChat = { ...danaChat, ...priya, asked: false };
    const both = { ...chats, [agentChatKey(priya, "chat")]: priyaChat };
    expect(agentChatFor(both, dana, "chat")).toEqual(danaChat);
    expect(agentChatFor(both, priya, "chat")).toEqual(priyaChat);
    expect(agentChatsInScope(both, priya)).toEqual([priyaChat]);
  });

  test("a legacy binding is ignored even if it is in the in-memory lookup", () => {
    const { principal: _principal, denBaseUrl: _denBaseUrl, ...legacy } = danaChat;
    const chats = { chat: legacy, [agentChatKey(dana, "chat")]: legacy };
    expect(agentChatFor(chats, dana, "chat")).toBeNull();
    expect(agentChatForAgent(chats, dana, "workspace", "bug-watcher")).toBeNull();
    expect(agentChatsInScope(chats, dana)).toEqual([]);
  });

  test("a standing chat with no cached role can ask for changes but gets no direct editing instructions", () => {
    const note = standingNote(danaChat);
    expect(note).toContain("standing conversation with a personal agent");
    expect(note).toContain("one or two plain sentences");
    expect(note).toContain("runPersonalAgentNow");
    expect(note).toContain("try requestPersonalAgentChange");
    expect(note).toContain("Say plainly what happened.");
    expect(note).not.toContain("updatePersonalAgent");
  });
});
