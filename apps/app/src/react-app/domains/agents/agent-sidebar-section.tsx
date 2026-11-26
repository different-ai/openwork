import type { PersonalAgentDetail } from "@openwork/types/den/personal-agents";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { SidebarGroup, SidebarGroupContent, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { t } from "@/i18n";

import { resolveAgentChatSession } from "./agent-chat-session";
import { agentChatForAgent, agentChatsInScope, useAgentChatStore, type AgentChat } from "./agent-chat-store";
import { AgentFace } from "./agent-face";
import { firstName } from "./agent-words";
import { useAgentsRuntime } from "./agents-runtime";
import { agentListKey, agentsQueryRoot, isActiveRun, useAgentListQuery } from "./use-agents";

type AgentRow = {
  key: string;
  name: string | null;
  agentId: string | null;
  chat: AgentChat | null;
  ownerName?: string;
  needsAttention?: boolean;
  working?: boolean;
};

export function agentSidebarGroups<T extends { listed?: boolean; agent: Pick<PersonalAgentDetail["agent"], "state"> }>(agents: readonly T[]) {
  const active = agents.filter((item) => item.agent.state === "active");
  return { listed: active.filter((item) => item.listed !== false), offered: active.filter((item) => item.listed === false) };
}

export function AgentSidebarSection() {
  const queryClient = useQueryClient();
  const [sharingOpen, setSharingOpen] = useState(false);
  const runtime = useAgentsRuntime();
  const chats = useAgentChatStore((state) => state.chats);
  const agents = useAgentListQuery(runtime).data;
  const open = useMutation({
    mutationKey: [...agentsQueryRoot(runtime), "open-chat"],
    mutationFn: async (row: AgentRow | null) => {
      if (!runtime) return;
      const { denBaseUrl, organizationId, principal, workspaceId, client } = runtime;
      const store = useAgentChatStore.getState();
      const agentId = row?.agentId;
      if (agentId) {
        const chat = agentChatForAgent(store.chats, runtime, workspaceId, agentId);
        const { sessionId, source } = await resolveAgentChatSession({
          localSessionId: chat?.sessionId ?? null,
          readPointer: async () => (await client.getPersonalAgentChat(organizationId, agentId, workspaceId)).chat?.sessionId ?? null,
          sessionState: (id) => runtime.sessionState(workspaceId, id),
          createSession: () => runtime.createSession(workspaceId),
        });
        if (!sessionId) return;
        store.open({ denBaseUrl, organizationId, principal, workspaceId, sessionId, agentId, agentName: row.name });
        if (source === "new") {
          store.save(runtime, sessionId, { chatLinkPending: true });
          if (row.name) runtime.renameSession(workspaceId, sessionId, row.name);
        } else {
          runtime.openSession(workspaceId, sessionId);
        }
        if (source === "new" || (source === "local" && chat?.chatLinkPending)) {
          await client.setPersonalAgentChat(organizationId, agentId, { workspaceId, sessionId });
          store.save(runtime, sessionId, { chatLinkPending: false });
          await queryClient.invalidateQueries({ queryKey: agentListKey(runtime) });
        }
        return;
      }
      const draft = row?.chat ?? agentChatsInScope(store.chats, runtime)
        .find((chat) => chat.workspaceId === workspaceId && !chat.agentId && !chat.asked);
      if (draft) {
        if (await runtime.sessionState(workspaceId, draft.sessionId) !== "gone") return runtime.openSession(workspaceId, draft.sessionId);
        store.forget(runtime, draft.sessionId);
        if (row) return;
      }
      const sessionId = await runtime.createSession(workspaceId);
      if (!sessionId) return;
      store.open({ denBaseUrl, organizationId, principal, workspaceId, sessionId });
    },
    onError: () => toast.error(t("agents.open_failed"), { id: "agent-chat-link" }),
  });
  if (!runtime) return null;

  const toRow = (item: PersonalAgentDetail): AgentRow => ({
    key: item.agent.id,
    name: item.agent.name,
    agentId: item.agent.id,
    chat: agentChatForAgent(chats, runtime, runtime.workspaceId, item.agent.id),
    ownerName: item.role === "owner" ? undefined : firstName(item.owner?.name),
    needsAttention: item.openRequestCount > 0,
    working: item.routines.some((routine) => isActiveRun(routine.latestRun)),
  });
  const { listed, offered } = agentSidebarGroups(agents ?? []);
  const sharedLabel = t("agents.shared_with_you", { count: offered.length });
  const rows: AgentRow[] = [
    ...listed.map(toRow),
    ...agentChatsInScope(chats, runtime)
      .filter((chat) => chat.workspaceId === runtime.workspaceId && chat.agentId === null)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((chat) => ({ key: chat.sessionId, name: chat.agentName, agentId: null, chat })),
  ];

  return (
    <SidebarGroup data-agents-section className="pb-0 pt-4">
      <SidebarGroupContent>
        <div className="flex h-6 items-center pe-2 ps-2.5">
          <span className="text-[11px] font-light text-muted-foreground">{t("agents.section")}</span>
          <button
            type="button"
            data-agents-new
            className="ml-auto flex size-5 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            disabled={open.isPending}
            onClick={() => open.mutate(null)}
            aria-label={t("agents.new_label")}
            title={t("agents.new_label")}
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        <SidebarMenu>
          {rows.map((row) => (
            <SidebarMenuItem key={row.key}>
              <SidebarMenuButton
                type="button"
                data-agent-row={row.agentId ?? "new"}
                data-agent-name={row.name ?? ""}
                isActive={row.chat !== null && row.chat.sessionId === runtime.selectedSessionId}
                tooltip={row.name ?? t("agents.new")}
                disabled={open.isPending}
                onClick={() => open.mutate(row)}
              >
                <AgentFace name={row.name} />
                <span className="min-w-0 flex-1 truncate">{row.name ?? t("agents.new")}</span>
                {row.ownerName ? <small className="max-w-20 truncate text-[11px] text-muted-foreground">{t("agents.row_from", { name: row.ownerName })}</small> : null}
                {row.needsAttention ? <span role="img" aria-label={t("agents.row_needs_attention")} className="size-1.5 shrink-0 rounded-full bg-amber-9" />
                  : row.working ? <span role="status" aria-label={t("agents.row_working")} className="size-1.5 shrink-0 motion-safe:animate-pulse rounded-full bg-blue-9" /> : null}
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          {offered.length > 0 && (
            <SidebarMenuItem>
              <Popover open={sharingOpen} onOpenChange={setSharingOpen}>
                <PopoverTrigger render={<SidebarMenuButton type="button" className="text-xs text-muted-foreground" disabled={open.isPending} data-agents-shared />}>
                  <span className="min-w-0 flex-1 truncate">{sharedLabel}</span>
                  <ChevronRight aria-hidden="true" />
                </PopoverTrigger>
                <PopoverContent side="inline-end" align="start" className="w-64 gap-0 rounded-2xl p-1.5">
                  <PopoverTitle className="sr-only">{sharedLabel}</PopoverTitle>
                  {offered.map(toRow).map((row) => (
                    <Button key={row.key} type="button" variant="ghost" size="sm" className="h-9 justify-start px-2" data-agent-shared-offer={row.agentId} onClick={() => {
                      setSharingOpen(false);
                      open.mutate(row);
                    }}>
                      <AgentFace name={row.name} />
                      <span className="min-w-0 flex-1 truncate text-start">{row.name}</span>
                      {row.ownerName && <small className="max-w-20 truncate text-xs font-normal text-muted-foreground">{t("agents.row_from", { name: row.ownerName })}</small>}
                    </Button>
                  ))}
                </PopoverContent>
              </Popover>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
