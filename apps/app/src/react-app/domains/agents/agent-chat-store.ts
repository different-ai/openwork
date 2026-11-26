import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { AgentScope } from "./agents-runtime";

export const PERSISTED_AGENT_CHAT_STORE_KEY = "openwork:personal-agent-chats:v2";

export type AgentChat = AgentScope & {
  workspaceId: string;
  sessionId: string;
  agentId: string | null;
  agentName: string | null;
  proposalId: string | null;
  routineId: string | null;
  routineName: string | null;
  firstRunId: string | null;
  chatLinkPending?: boolean;
  asked: boolean;
  createdAt: number;
};

type StoredAgentChat = Omit<AgentChat, "denBaseUrl" | "principal"> & Partial<Pick<AgentScope, "denBaseUrl" | "principal">>;

export type AgentChatProgress = Partial<Pick<AgentChat, "agentId" | "agentName" | "proposalId" | "routineId" | "routineName" | "firstRunId" | "chatLinkPending">>;

export type AgentPanelView = "overview" | "settings" | "memory";

type AgentChatStore = {
  chats: Record<string, StoredAgentChat>;
  panel: { chatKey: string; view: AgentPanelView } | null;
  open: (chat: AgentScope & Pick<AgentChat, "workspaceId" | "sessionId"> & AgentChatProgress) => void;
  save: (scope: AgentScope, sessionId: string, progress: AgentChatProgress) => void;
  markAsked: (scope: AgentScope, sessionId: string) => void;
  forget: (scope: AgentScope, sessionId: string) => void;
  setPanel: (chatKey: string | null, view?: AgentPanelView) => void;
};

export function agentChatKey(scope: AgentScope, sessionId: string): string {
  return JSON.stringify([scope.denBaseUrl, scope.organizationId, scope.principal, sessionId]);
}

function chatInScope(chat: StoredAgentChat, scope: AgentScope): chat is AgentChat {
  return Boolean(scope.principal) && chat.principal === scope.principal
    && chat.organizationId === scope.organizationId && chat.denBaseUrl === scope.denBaseUrl;
}

export function agentChatsInScope(chats: Record<string, StoredAgentChat>, scope: AgentScope): AgentChat[] {
  return Object.values(chats).filter((chat) => chatInScope(chat, scope));
}

export const useAgentChatStore = create<AgentChatStore>()(persist((set) => ({
  chats: {},
  panel: null,
  open: (chat) => set((state) => {
    const key = agentChatKey(chat, chat.sessionId);
    const existing = agentChatFor(state.chats, chat, chat.sessionId) ?? {
      agentId: null,
      agentName: null,
      proposalId: null,
      routineId: null,
      routineName: null,
      firstRunId: null,
      asked: false,
      createdAt: Date.now(),
    };
    return { chats: { ...state.chats, [key]: { ...existing, ...chat } } };
  }),
  save: (scope, sessionId, progress) => set((state) => {
    const chat = agentChatFor(state.chats, scope, sessionId);
    return chat ? { chats: { ...state.chats, [agentChatKey(scope, sessionId)]: { ...chat, ...progress } } } : state;
  }),
  markAsked: (scope, sessionId) => set((state) => {
    const chat = agentChatFor(state.chats, scope, sessionId);
    return chat && !chat.asked ? { chats: { ...state.chats, [agentChatKey(scope, sessionId)]: { ...chat, asked: true } } } : state;
  }),
  forget: (scope, sessionId) => set((state) => {
    const key = agentChatKey(scope, sessionId);
    const { [key]: _removed, ...chats } = state.chats;
    return { chats, panel: state.panel?.chatKey === key ? null : state.panel };
  }),
  setPanel: (chatKey, view = "overview") => set({ panel: chatKey === null ? null : { chatKey, view } }),
}), {
  name: PERSISTED_AGENT_CHAT_STORE_KEY,
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({ chats: state.chats }),
}));

export function isStandingChat(chat: AgentChat): boolean {
  return chat.agentId !== null && (chat.routineId !== null || chat.proposalId === null);
}

export function agentChatFor(chats: Record<string, StoredAgentChat>, scope: AgentScope | null, sessionId: string | null): AgentChat | null {
  if (!scope || !sessionId) return null;
  const chat = chats[agentChatKey(scope, sessionId)];
  return chat && chatInScope(chat, scope) ? chat : null;
}

export function agentChatForAgent(chats: Record<string, StoredAgentChat>, scope: AgentScope, workspaceId: string, agentId: string): AgentChat | null {
  return agentChatsInScope(chats, scope)
    .filter((chat) => chat.workspaceId === workspaceId && chat.agentId === agentId)
    .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}
