import { useId } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AutomationSchedule } from "@openwork/types/automations";
import type { PersonalAgentAccess, PersonalAgentChange, PersonalAgentDetail, PersonalAgentRequest, PersonalAgentToolCatalog, PersonalAgentToolPolicy } from "@openwork/types/den/personal-agents";
import { toast } from "sonner";

import { DenApiError } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { currentLocale, t } from "@/i18n";

import { firstName, scheduleInWords } from "./agent-words";
import type { AgentsRuntime } from "./agents-runtime";
import { useAgentToolsQuery } from "./use-agent-permissions";
import { agentRequestsKey, agentsQueryRoot } from "./use-agents";

export function changeRequestLine(request: Pick<PersonalAgentRequest, "status" | "summary" | "requestedBy" | "decidedBy" | "canDecide">, ownerName: string | null): string | null {
  const summary = request.summary?.trim() || t("agents.change_summary");
  const decider = request.decidedBy?.name || t("agents.change_reviewer");
  if (request.status === "approved") return t("agents.change_approved", { decider, summary });
  if (request.status === "denied") return t("agents.change_denied", { decider, summary });
  if (request.status !== "pending") return null;
  if (request.canDecide.includes("approve") || request.canDecide.includes("deny")) return t("agents.change_asks", { name: firstName(request.requestedBy.name), summary });
  return t("agents.change_waiting", { name: firstName(ownerName) || t("agents.panel_agent_owner"), summary });
}

function changeScheduleWords(schedule: AutomationSchedule): string {
  const zone = schedule.timezone;
  if (schedule.kind === "calendar") {
    const { offsetMinutes, rule } = schedule;
    const edge = schedule.edge === "start" ? t("agents.change_schedule_meeting_start") : t("agents.change_schedule_meeting_end");
    const count = Math.abs(offsetMinutes);
    const timing = offsetMinutes < 0 ? t("agents.change_schedule_meeting_before", { count, edge })
      : offsetMinutes > 0 ? t("agents.change_schedule_meeting_after", { count, edge })
      : t("agents.change_schedule_meeting_at", { edge });
    return [t("agents.change_schedule_zone", { schedule: timing, zone }),
      rule.withExternalAttendees && t("agents.change_schedule_meeting_external"),
      rule.titleIncludes && t("agents.change_schedule_meeting_title", { title: rule.titleIncludes }),
    ].filter(Boolean).join(". ");
  }
  const words = schedule.kind === "once"
    ? t("agents.change_schedule_once", { dateTime: new Intl.DateTimeFormat(currentLocale(), { dateStyle: "medium", timeStyle: "medium", timeZone: zone }).format(schedule.at) })
    : scheduleInWords(schedule);
  return t("agents.change_schedule_zone", { schedule: words, zone });
}

function policyEntries(policy: PersonalAgentToolPolicy | undefined) {
  const entries = new Map<string, { connectionId: string; toolName?: string; access: PersonalAgentAccess }>();
  for (const [connectionId, access] of Object.entries(policy?.connections ?? {})) {
    entries.set(JSON.stringify([connectionId]), { connectionId, access });
  }
  for (const [connectionId, tools] of Object.entries(policy?.tools ?? {})) {
    for (const [toolName, access] of Object.entries(tools)) {
      entries.set(JSON.stringify([connectionId, toolName]), { connectionId, toolName, access });
    }
  }
  return entries;
}

function toolChangeLines(nextPolicy: PersonalAgentToolPolicy, currentPolicy?: PersonalAgentToolPolicy, catalog?: PersonalAgentToolCatalog) {
  const next = policyEntries(nextPolicy);
  const current = policyEntries(currentPolicy);
  const connections = new Map(catalog?.connections.map((connection) => [connection.connectionId, connection]));
  const labels = { allow: t("agents.permissions_allow"), ask: t("agents.permissions_ask"), block: t("agents.permissions_block") };
  return [...new Map([...next, ...current])].flatMap(([key, { connectionId, toolName }]) => {
    const access = next.get(key)?.access;
    if (access === current.get(key)?.access) return [];
    const connection = connections.get(connectionId);
    const app = connection?.name || t("agents.change_tools_unknown_app");
    const tool = connection?.tools.find((item) => item.name === toolName)?.title || toolName;
    return [{ key, text: `${tool ? `${app} · ${tool}` : app}: ${access ? labels[access] : t("agents.change_tools_default")}` }];
  });
}

type ChangeRow = { key: string; text: string; block?: "instructions" | "brief" };

export function agentChangeDetails(change: PersonalAgentChange | null, { routines = [], toolPolicy: currentPolicy, catalog }: {
  routines?: PersonalAgentDetail["routines"];
  toolPolicy?: PersonalAgentToolPolicy;
  catalog?: PersonalAgentToolCatalog;
} = {}) {
  const rows: ChangeRow[] = [];
  if (!change) return { rows, tools: null };
  const { newRoutine, routineId, name, active, schedule, instructions, brief, toolPolicy } = change;
  if (newRoutine) {
    rows.push({ key: "add", text: t("agents.change_add_routine", { name: newRoutine.name, schedule: changeScheduleWords(newRoutine.schedule) }) });
    rows.push({ key: "add-instructions", block: "instructions", text: newRoutine.instructions });
  }
  if (name || active !== undefined || schedule || instructions) {
    const available = routines.filter((routine) => routine.state !== "archived");
    const routine = routineId ? routines.find((item) => item.id === routineId) : available.length === 1 ? available[0] : undefined;
    rows.push({ key: "edit", text: routine ? t("agents.change_edit_routine", { name: routine.name }) : t("agents.change_edit_routine_unknown") });
    if (name) rows.push({ key: "rename", text: t("agents.change_rename", { name }) });
    if (active !== undefined) rows.push({ key: "active", text: active ? t("agents.change_turn_on") : t("agents.change_turn_off") });
    if (schedule) rows.push({ key: "schedule", text: t("agents.change_schedule", { schedule: changeScheduleWords(schedule) }) });
    if (instructions) rows.push({ key: "instructions", block: "instructions", text: instructions });
  }
  if (brief) rows.push({ key: "brief", block: "brief", text: brief });
  return { rows, tools: toolPolicy ? toolChangeLines(toolPolicy, currentPolicy, catalog) : null };
}

export function isStaleChange(error: unknown): boolean {
  return error instanceof DenApiError && error.status === 409 && error.code === "personal_agent_change_stale";
}

export function AgentChangeRequest({ runtime, agent, request }: { runtime: AgentsRuntime; agent: PersonalAgentDetail; request: PersonalAgentRequest }) {
  const titleId = useId();
  const key = agentRequestsKey(runtime, agent.agent.id);
  const queryClient = useQueryClient();
  const catalog = useAgentToolsQuery(runtime, agent.agent.id, request.status === "pending" && Boolean(request.change?.toolPolicy));
  const decide = useMutation({
    mutationFn: (decision: "approve" | "deny") => runtime.client.decidePersonalAgentRequest(runtime.organizationId, agent.agent.id, request.id, decision),
    onSuccess: async (decided) => {
      queryClient.setQueryData<PersonalAgentRequest[]>(key, (items) => items?.map((item) => item.id === decided.id ? decided : item));
      await queryClient.invalidateQueries({ queryKey: agentsQueryRoot(runtime) });
    },
    onError: async (error) => {
      if (isStaleChange(error)) await queryClient.invalidateQueries({ queryKey: agentsQueryRoot(runtime) });
      else toast.error(t("agents.change_failed"));
    },
  });
  const line = changeRequestLine(request, agent.owner?.name ?? null);
  if (!line) return null;
  if (request.status !== "pending") return <p className="text-xs text-dls-secondary" role="status">{line}</p>;
  const canApprove = request.canDecide.includes("approve");
  const canDeny = request.canDecide.includes("deny");
  const stale = isStaleChange(decide.error);
  const { rows, tools } = agentChangeDetails(request.change, { routines: agent.routines, toolPolicy: agent.revision.toolPolicy, catalog: catalog.data });
  return (
    <section aria-labelledby={titleId} className="w-full max-w-xl space-y-2 rounded-xl border border-dls-border bg-dls-surface p-3">
      <p id={titleId} className="wrap-anywhere text-sm font-medium">{line}</p>
      {rows.map(({ key: rowKey, block, text }) => block ? (
        <details key={rowKey} open data-agent-change-instructions={block === "instructions" ? "" : undefined} data-agent-change-brief={block === "brief" ? "" : undefined}>
          <summary className="cursor-pointer text-sm font-medium">{block === "instructions" ? t("agents.change_instructions") : t("agents.change_brief")}</summary>
          <div tabIndex={0} className="max-h-48 overflow-auto whitespace-pre-wrap wrap-anywhere text-sm text-dls-secondary">{text}</div>
        </details>
      ) : <p key={rowKey} className="whitespace-pre-wrap wrap-anywhere text-sm text-dls-secondary">{text}</p>)}
      {tools && <details data-agent-change-tools open>
        <summary className="cursor-pointer text-sm font-medium">{t("agents.change_tools")}</summary>
        {tools.length ? <ul tabIndex={0} className="max-h-48 list-disc overflow-auto ps-5 text-sm text-dls-secondary">
          {tools.map((tool) => <li key={tool.key} className="wrap-anywhere">{tool.text}</li>)}
        </ul> : <p className="text-sm text-dls-secondary">{t("agents.change_tools_unchanged")}</p>}
      </details>}
      {stale && <p role="status" className="text-sm text-dls-secondary">{t("agents.change_stale")}</p>}
      {(canApprove || canDeny) && (
        <div className="flex gap-2">
          {canApprove && <Button size="sm" disabled={decide.isPending || stale || (Boolean(request.change?.toolPolicy) && catalog.isPending)} onClick={() => decide.mutate("approve")}>{t("agents.change_approve")}</Button>}
          {canDeny && <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate("deny")}>{t("agents.change_deny")}</Button>}
        </div>
      )}
    </section>
  );
}
