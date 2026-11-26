import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PERSONAL_AGENT_MEMORY_MAX_LENGTH, type PersonalAgentMemory, type SetPersonalAgentMemory } from "@openwork/types/den/personal-agents";
import { ArrowLeft, Lock } from "lucide-react";

import { DenApiError } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { currentLocale, t } from "@/i18n";

import type { AgentsRuntime } from "./agents-runtime";
import { agentMemoryKey } from "./use-agents";

export function useAgentMemory(runtime: AgentsRuntime, agentId: string) {
  return useQuery({
    queryKey: agentMemoryKey(runtime, agentId),
    queryFn: () => runtime.client.getPersonalAgentMemory(runtime.organizationId, agentId),
    refetchOnMount: "always",
  });
}

export function agentMemoryUpdatedLine(memory: Pick<PersonalAgentMemory, "updatedAt" | "updatedBy">, now: number): string | null {
  if (memory.updatedAt === null) return null;
  const minutes = Math.floor(Math.max(0, now - memory.updatedAt) / 60_000);
  const time = new Intl.RelativeTimeFormat(currentLocale(), { numeric: "auto" });
  const when = minutes < 1 ? time.format(0, "second") : minutes < 60 ? time.format(-minutes, "minute")
    : minutes < 1440 ? time.format(-Math.floor(minutes / 60), "hour") : time.format(-Math.floor(minutes / 1440), "day");
  if (!memory.updatedBy) return t("agents.memory_updated_agent", { when });
  return t("agents.memory_updated_person", { name: memory.updatedBy.name || t("agents.memory_teammate"), when });
}

export function isAgentMemoryConflict(error: unknown): boolean {
  return error instanceof DenApiError && error.status === 409 && error.code === "personal_agent_memory_conflict";
}

export function AgentRoutineHistory({ routines }: Pick<PersonalAgentMemory, "routines">) {
  if (!routines.length) return null;
  return <section className="space-y-3 border-t border-dls-border pt-3">
    <div className="space-y-1">
      <h3 className="text-sm font-semibold">{t("agents.memory_routine_history")}</h3>
      <p className="text-xs text-dls-secondary">{t("agents.memory_routine_private")}</p>
    </div>
    {routines.map((routine) => <div key={routine.routineId} data-agent-routine-state={routine.name} className="space-y-1">
      <p className="text-sm font-medium">{routine.name}</p>
      <p className="whitespace-pre-wrap wrap-anywhere text-sm text-dls-secondary">{routine.state}</p>
    </div>)}
  </section>;
}

export function AgentMemoryView({ runtime, agentId, isOwner, query, onBack }: {
  runtime: AgentsRuntime;
  agentId: string;
  isOwner: boolean;
  query: ReturnType<typeof useAgentMemory>;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SetPersonalAgentMemory | null>(null);
  const notesId = useId();
  const countId = useId();
  const key = agentMemoryKey(runtime, agentId);
  const memory = query.data;
  const updated = memory && agentMemoryUpdatedLine(memory, Date.now());
  const save = useMutation({
    mutationFn: (input: SetPersonalAgentMemory) => runtime.client.setPersonalAgentMemory(runtime.organizationId, agentId, input),
    onSuccess: (next) => {
      queryClient.setQueryData(key, next);
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const conflict = isAgentMemoryConflict(save.error);
  const reload = async () => {
    const result = await query.refetch();
    if (!result.isSuccess) return;
    if (conflict) {
      setDraft((current) => current && { ...current, expectedVersion: result.data.version });
      save.reset();
    }
  };

  return (
    <section data-agent-memory className="flex flex-col gap-4">
      <div className="flex min-h-10 items-center gap-2">
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("agents.memory_back")} onClick={onBack}><ArrowLeft aria-hidden="true" /></Button>
        <h2 className="flex-1 text-sm font-semibold">{t("agents.memory_title")}</h2>
        {memory?.canEdit && !draft && <Button type="button" size="sm" variant="ghost" data-agent-memory-edit onClick={() => setDraft({ notes: memory.notes, expectedVersion: memory.version })}>{t("agents.memory_edit")}</Button>}
      </div>
      <p className="text-xs text-dls-secondary">{t("agents.memory_shared")}</p>
      {query.isPending && <Skeleton className="h-20 w-full" />}
      {query.isError && <div className="flex items-center gap-2">
        <p role="status" className="text-xs text-dls-secondary">{t("agents.memory_load_failed")}</p>
        {!conflict && <Button type="button" size="sm" variant="ghost" onClick={() => void reload()}>{t("agents.memory_reload")}</Button>}
      </div>}
      {memory && <>
        {draft && memory.canEdit ? <form className="flex flex-col gap-2" onSubmit={(event) => {
          event.preventDefault();
          if (!conflict && !save.isPending && draft.notes.length <= PERSONAL_AGENT_MEMORY_MAX_LENGTH) save.mutate(draft);
        }}>
          <label className="text-sm font-medium" htmlFor={notesId}>{t("agents.memory_notes")}</label>
          <Textarea id={notesId} aria-describedby={countId} data-agent-memory-input className="min-h-32" value={draft.notes} maxLength={PERSONAL_AGENT_MEMORY_MAX_LENGTH} readOnly={save.isPending} onChange={(event) => setDraft({ ...draft, notes: event.currentTarget.value })} />
          <p id={countId} className="text-xs text-dls-secondary">{t("agents.memory_count", { count: draft.notes.length, max: PERSONAL_AGENT_MEMORY_MAX_LENGTH })}</p>
          {conflict ? <div className="space-y-1">
            <p role="alert" className="text-xs text-destructive">{t("agents.memory_conflict")}</p>
            <Button type="button" size="sm" variant="outline" disabled={query.isFetching} onClick={() => void reload()}>{t("agents.memory_reload")}</Button>
          </div> : save.isError && <p role="alert" className="text-xs text-destructive">{t("agents.memory_save_failed")}</p>}
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" data-agent-memory-save disabled={conflict || save.isPending}>{t("agents.memory_save")}</Button>
            <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => { save.reset(); setDraft(null); }}>{t("agents.memory_cancel")}</Button>
          </div>
        </form> : <p data-agent-memory-notes className="whitespace-pre-wrap wrap-anywhere text-sm">{memory.notes || t("agents.memory_empty")}</p>}
        {updated && <p className="text-xs text-dls-secondary">{updated}</p>}
        {!memory.canEdit && <p className="flex items-start gap-2 text-xs text-dls-secondary"><Lock aria-hidden="true" className="size-4 shrink-0" />{t("agents.memory_readonly")}</p>}
        {isOwner && <AgentRoutineHistory routines={memory.routines} />}
      </>}
    </section>
  );
}
