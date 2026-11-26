import { agentChatFor, isStandingChat, useAgentChatStore } from "./agent-chat-store";
import type { AgentScope } from "./agents-runtime";

type ChatBindings = ReturnType<typeof useAgentChatStore.getState>["chats"];

export type StandingChatFeature = "enabled" | "disabled" | "unknown";

export function standingChatMode(chats: ChatBindings, scope: AgentScope | null, sessionId: string | null, feature: StandingChatFeature) {
  if (!sessionId || (!isStandingChatSessionId(sessionId) && !Object.values(chats).some((chat) => chat.sessionId === sessionId && isStandingChat(chat)))) return "workspace";
  const chat = agentChatFor(chats, scope, sessionId);
  return chat && isStandingChat(chat) && feature === "enabled" ? "scoped" : "locked";
}

export function standingChatSessionId(agentId: string) {
  return `agent-chat:${agentId}`;
}

export function isStandingChatSessionId(sessionId: string) {
  return sessionId.startsWith("agent-chat:");
}

export function assertWorkspaceChat(sessionId: string) {
  if (standingChatMode(useAgentChatStore.getState().chats, null, sessionId, "unknown") !== "workspace") {
    throw new Error("This agent can only be reached from its own chat.");
  }
}

export function standingChatFeature(features: Record<string, boolean> | undefined): StandingChatFeature {
  const enabled = features?.personalAgents;
  return enabled === true ? "enabled" : enabled === false ? "disabled" : "unknown";
}
