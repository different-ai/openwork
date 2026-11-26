import type { PersonalAgentDetail } from "@openwork/types/den/personal-agents";
import { BookOpen, Clock, Play, SlidersHorizontal, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";

import { AgentCanUse } from "./agent-can-use";
import { agentChatFor, agentChatKey, useAgentChatStore, type AgentPanelView } from "./agent-chat-store";
import { AgentFace } from "./agent-face";
import { AGENT_PANEL_ID } from "./agent-header";
import { AgentMemoryView, useAgentMemory } from "./agent-memory";
import { AgentSettings } from "./agent-settings";
import { AgentShare } from "./agent-share";
import { firstName, scheduleInWords, whenInWords } from "./agent-words";
import { useAgentsRuntime, type AgentsRuntime } from "./agents-runtime";
import { agentRunQueueMessage, useAgentActions, useAgentDetail } from "./use-agents";

export function AgentPanel(props: { sessionId: string | null; compact?: boolean }) {
  const runtime = useAgentsRuntime();
  const chat = useAgentChatStore((state) => agentChatFor(state.chats, runtime, props.sessionId));
  const panelKey = chat ? agentChatKey(chat, chat.sessionId) : null;
  const view = useAgentChatStore((state) => panelKey !== null && state.panel?.chatKey === panelKey ? state.panel.view : null);
  const agent = useAgentDetail(runtime, chat?.agentId);
  if (!runtime || !agent || !panelKey || !view) return null;
  const content = <AgentPanelBody key={panelKey} runtime={runtime} agent={agent} view={view} compact={props.compact}
    setView={(next) => useAgentChatStore.getState().setPanel(panelKey, next)} />;
  if (props.compact) return (
    <Sheet open onOpenChange={(next) => { if (!next) useAgentChatStore.getState().setPanel(null); }}>
      <SheetContent id={AGENT_PANEL_ID} data-agent-panel={agent.agent.id} className="w-full gap-5 overflow-y-auto bg-dls-surface px-4 pb-4 pt-2">
        <SheetTitle className="sr-only">{agent.agent.name}</SheetTitle>
        {content}
      </SheetContent>
    </Sheet>
  );
  return <aside id={AGENT_PANEL_ID} data-agent-panel={agent.agent.id} aria-label={agent.agent.name} className="flex w-75 shrink-0 flex-col gap-5 overflow-y-auto border-l border-dls-border bg-dls-surface px-4 pb-4 pt-2">{content}</aside>;
}

function AgentPanelBody({ runtime, agent, view, compact, setView }: {
  runtime: AgentsRuntime;
  agent: PersonalAgentDetail;
  view: AgentPanelView;
  compact?: boolean;
  setView: (view: AgentPanelView) => void;
}) {
  const actions = useAgentActions(runtime);
  const { id: agentId, name, pausedAt } = agent.agent;
  const memoryQuery = useAgentMemory(runtime, agentId);
  const isOwner = agent.role === "owner";
  const states = new Map(isOwner ? memoryQuery.data?.routines.map((routine) => [routine.routineId, routine.state]) : []);
  const paused = pausedAt !== null;
  const canManage = agent.role !== "collaborator";
  const routines = agent.routines.filter((routine) => routine.state !== "archived");
  const on = routines.some((routine) => routine.state === "active");
  const nextDueAt = routines.flatMap((routine) => routine.state === "active" && routine.nextDueAt !== null ? [Date.parse(routine.nextDueAt)] : []).sort((a, b) => a - b)[0];
  const firstRoutine = routines[0];
  const runQueueMessage = agentRunQueueMessage(actions.runNow.error);

  return (
    <>
      {view === "settings" ? <AgentSettings runtime={runtime} agent={agent} onBack={() => setView("overview")} />
        : view === "memory" ? <AgentMemoryView runtime={runtime} agentId={agentId} isOwner={isOwner} query={memoryQuery} onBack={() => setView("overview")} /> : <>
        <div className="flex h-8 items-center justify-end">
          {!compact && <Button type="button" variant="ghost" size="icon-sm" aria-label={t("agents.panel_close")} onClick={() => useAgentChatStore.getState().setPanel(null)}>
            <X className="size-4" />
          </Button>}
        </div>
        <div className="flex flex-col items-center gap-2">
          <AgentFace name={name} size="lg" />
          <p className="text-[15px] font-medium text-dls-text">{name}</p>
          {agent.role !== "owner" && <p className="text-xs text-dls-secondary">{t("agents.panel_shared_role", {
            name: firstName(agent.owner?.name) || t("agents.panel_agent_owner"),
            role: agent.role === "manager" ? t("agents.share_manager") : t("agents.share_collaborator"),
          })}</p>}
        </div>
        <AgentCanUse runtime={runtime} agentId={agentId} placement="panel" onOpen={() => setView("settings")} />
        <div className="flex min-h-12 items-center justify-between gap-3 border-y border-dls-border py-2">
          {paused ? <p className="text-sm font-medium">{t("agents.panel_admin_paused")}</p> : <>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-dls-text">{on ? t("agents.panel_on") : t("agents.panel_off")}</span>
              <span className="block text-xs text-dls-secondary">
                {!on ? t("agents.panel_paused") : nextDueAt !== undefined ? t("agents.panel_next_run", { when: whenInWords(nextDueAt, Date.now()) }) : t("agents.panel_no_next_run")}
              </span>
            </span>
            <Switch
              aria-label={t("agents.panel_schedule_switch")}
              title={!canManage ? t("agents.panel_schedule_readonly") : undefined}
              size="sm"
              checked={on}
              disabled={!canManage || routines.length === 0 || actions.setActive.isPending}
              onCheckedChange={(active) => actions.setActive.mutate(
                { agentId, owner: agent.owner, routineIds: routines.map((routine) => routine.id), active },
                { onError: () => toast.error(t("agents.panel_schedule_failed")) },
              )}
            />
          </>}
        </div>
        <section className="flex flex-col">
          <h2 className="pb-1 text-xs text-dls-secondary">{t("agents.panel_routines")}</h2>
          {routines.length === 0 ? <p className="text-sm text-dls-secondary">{t("agents.panel_no_routines")}</p> : null}
          {routines.map((routine) => {
            const state = states.get(routine.id);
            return (
              <div key={routine.id} data-agent-routine={routine.id} className="flex min-h-11 items-center gap-3 border-b border-dls-border py-2 last:border-b-0">
                <Clock aria-hidden="true" className="size-4 shrink-0 text-dls-secondary" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-dls-text">{routine.name}</span>
                  <span className="block truncate text-xs text-dls-secondary">{scheduleInWords(routine.schedule)}</span>
                  {state && <span className="block truncate text-xs text-dls-secondary" data-agent-routine-state={routine.name}>{t("agents.memory_last_time", { state: Array.from(state).slice(0, 140).join("") })}</span>}
                </span>
              </div>
            );
          })}
        </section>
        <Button type="button" variant="ghost" className="min-h-10 w-full justify-start" data-agent-memory-open onClick={() => setView("memory")}>
          <BookOpen aria-hidden="true" />{t("agents.memory_title")}
        </Button>
        <div className="flex flex-wrap gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-agent-run-now
            disabled={paused || !firstRoutine || actions.runNow.isPending}
            onClick={() => actions.runNow.mutate(
              { agentId, routineId: firstRoutine?.id },
              { onSuccess: () => toast.success(t("agents.panel_run_started")) },
            )}
          >
            <Play aria-hidden="true" />{t("agents.panel_run_now")}
          </Button>
          {canManage && agent.canShare !== false && <AgentShare runtime={runtime} agent={agent} />}
          <Button type="button" variant="ghost" size="sm" onClick={() => setView("settings")}>
            <SlidersHorizontal aria-hidden="true" />{t("agents.panel_settings_button")}
          </Button>
        </div>
        {runQueueMessage && <p role="status" className="text-xs text-dls-secondary">{runQueueMessage}</p>}
        {agent.role === "owner" && agent.canShare === false && (
          <p className="text-xs text-dls-secondary">{t("agents.share_admin_only")}</p>
        )}
      </>}
    </>
  );
}
