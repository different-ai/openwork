"use client";

import { useEffect, useMemo, useState } from "react";
import { Cloud, X } from "lucide-react";
import type { AutomationDetail, AutomationSchedule } from "@openwork/types/automations";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenSelect } from "../../_components/ui/select";
import { DenTextarea } from "../../_components/ui/textarea";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useOrgLlmProviders } from "./llm-provider-data";
import { useCreateCloudAutomation, useUpdateAutomation } from "./automation-data";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Props = {
  automation?: AutomationDetail;
  onClose: () => void;
  onSaved: (automationId: string) => void;
};

function localDateTime(timestamp: number) {
  const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function initialTime(schedule?: AutomationSchedule) {
  return schedule?.kind === "daily" || schedule?.kind === "weekly"
    ? `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`
    : "09:00";
}

export function CloudAutomationForm({ automation, onClose, onSaved }: Props) {
  const { orgId, orgContext } = useOrgDashboard();
  const { llmProviders, busy, error } = useOrgLlmProviders(orgId, { scope: "usable" });
  const createAutomation = useCreateCloudAutomation();
  const updateAutomation = useUpdateAutomation();
  const action = automation?.revision.action?.kind === "agent" ? automation.revision.action : null;
  const models = useMemo(() => llmProviders.flatMap((provider) => provider.models.map((model) => ({
    key: `${provider.source === "openwork" ? "openwork" : provider.id}:${model.id}`,
    providerId: provider.source === "openwork" ? "openwork" : provider.id,
    providerName: provider.name,
    modelId: model.id,
    modelName: model.name,
  }))), [llmProviders]);
  const [name, setName] = useState(automation?.automation.name ?? "");
  const [instructions, setInstructions] = useState(action?.instructions ?? "");
  const [scheduleKind, setScheduleKind] = useState<AutomationSchedule["kind"]>(automation?.revision.schedule.kind ?? "daily");
  const [time, setTime] = useState(initialTime(automation?.revision.schedule));
  const [onceAt, setOnceAt] = useState(localDateTime(automation?.revision.schedule.kind === "once" ? automation.revision.schedule.at : Date.now() + 60 * 60_000));
  const [days, setDays] = useState<number[]>(automation?.revision.schedule.kind === "weekly" ? automation.revision.schedule.daysOfWeek : [1]);
  const [modelKey, setModelKey] = useState(action ? `${action.model.providerId}:${action.model.modelId}` : "");
  const [timezone, setTimezone] = useState(automation?.revision.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
  const cloudEnabled = orgContext?.capabilities.cloud === true;
  const mutation = automation ? updateAutomation : createAutomation;

  useEffect(() => {
    if (!modelKey && models[0]) setModelKey(models[0].key);
  }, [modelKey, models]);

  const schedule = (): AutomationSchedule | null => {
    if (scheduleKind === "once") {
      const at = new Date(onceAt).getTime();
      return Number.isFinite(at) ? { kind: "once", timezone, at } : null;
    }
    const [hourValue, minuteValue] = time.split(":");
    const hour = Number(hourValue);
    const minute = Number(minuteValue);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    return scheduleKind === "daily"
      ? { kind: "daily", timezone, hour, minute }
      : days.length > 0 ? { kind: "weekly", timezone, daysOfWeek: days, hour, minute } : null;
  };

  const submit = async () => {
    const model = models.find((entry) => entry.key === modelKey);
    const nextSchedule = schedule();
    if (!model || !nextSchedule || !name.trim() || !instructions.trim()) return;
    const modelSelection = {
      providerId: model.providerId,
      modelId: model.modelId,
      ...(action?.model.providerId === model.providerId && action.model.modelId === model.modelId && action.model.variant
        ? { variant: action.model.variant }
        : {}),
    };
    try {
      const saved = automation
        ? await updateAutomation.mutateAsync({
            automationId: automation.automation.id,
            changes: {
              name: name.trim(),
              schedule: nextSchedule,
              action: { kind: "agent", instructions: instructions.trim(), model: modelSelection },
              executionTarget: "cloud",
            },
          })
        : await createAutomation.mutateAsync({
            name: name.trim(),
            schedule: nextSchedule,
            action: { kind: "agent", instructions: instructions.trim(), model: modelSelection },
          });
      onSaved(saved.automation.id);
    } catch {
      // The mutation exposes the server's actionable message below.
    }
  };

  const toggleDay = (day: number) => setDays((current) => current.includes(day)
    ? current.filter((value) => value !== day)
    : [...current, day].sort((left, right) => left - right));

  return (
    <section className="mt-6 rounded-2xl border border-sky-100 bg-sky-50/40 p-5">
      <div className="flex items-start justify-between gap-4">
        <div><h2 className="flex items-center gap-2 text-[14px] font-semibold text-gray-900"><Cloud className="h-4 w-4 text-sky-600" />{automation ? "Edit Cloud Automation" : "New Cloud Automation"}</h2><p className="mt-1 text-[12px] text-gray-500">Runs in OpenWork Cloud even when your desktop is offline. A stopped Cloud container wakes automatically.</p></div>
        <button type="button" aria-label="Close Cloud Automation form" onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-white hover:text-gray-700"><X className="h-4 w-4" /></button>
      </div>
      {!cloudEnabled ? <p className="mt-4 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-[12px] text-amber-700">OpenWork Cloud is not enabled for this workspace.</p> : null}
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <label className="space-y-1.5 text-[12px] font-medium text-gray-700">Name<DenInput value={name} onChange={(event) => setName(event.target.value)} placeholder="Morning customer brief" maxLength={120} /></label>
        <label className="space-y-1.5 text-[12px] font-medium text-gray-700">Model<DenSelect value={modelKey} onChange={(event) => setModelKey(event.target.value)} disabled={busy || models.length === 0} aria-label="Automation model"><option value="">{busy ? "Loading models…" : "Select a model"}</option>{models.map((model) => <option key={model.key} value={model.key}>{model.providerName} · {model.modelName}</option>)}</DenSelect></label>
        <label className="space-y-1.5 text-[12px] font-medium text-gray-700 md:col-span-2">Instructions<DenTextarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={5} placeholder="Review my connected sources and prepare…" maxLength={100_000} /></label>
        <label className="space-y-1.5 text-[12px] font-medium text-gray-700">Schedule<DenSelect value={scheduleKind} onChange={(event) => setScheduleKind(event.target.value as AutomationSchedule["kind"])}><option value="once">Once</option><option value="daily">Daily</option><option value="weekly">Weekly</option></DenSelect></label>
        {scheduleKind === "once"
          ? <label className="space-y-1.5 text-[12px] font-medium text-gray-700">Run at<DenInput type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} /></label>
          : <label className="space-y-1.5 text-[12px] font-medium text-gray-700">Time<DenInput type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label>}
        {scheduleKind === "weekly" ? <div className="md:col-span-2"><p className="mb-2 text-[12px] font-medium text-gray-700">Days</p><div className="flex flex-wrap gap-2">{WEEKDAYS.map((label, day) => <button key={label} type="button" onClick={() => toggleDay(day)} className={`rounded-lg border px-3 py-1.5 text-[12px] ${days.includes(day) ? "border-sky-300 bg-sky-100 text-sky-800" : "border-gray-200 bg-white text-gray-500"}`}>{label}</button>)}</div></div> : null}
        <label className="space-y-1.5 text-[12px] font-medium text-gray-700 md:col-span-2">Timezone<DenInput value={timezone} onChange={(event) => setTimezone(event.target.value)} /></label>
      </div>
      {error ? <p className="mt-3 text-[12px] text-red-600">{error}</p> : null}
      {mutation.error ? <p className="mt-3 text-[12px] text-red-600">{mutation.error.message}</p> : null}
      <div className="mt-5 flex justify-end gap-2"><DenButton variant="secondary" onClick={onClose}>Cancel</DenButton><DenButton loading={mutation.isPending} disabled={!cloudEnabled || !name.trim() || !instructions.trim() || !modelKey || !schedule()} onClick={() => void submit()}>{automation ? "Save revision" : "Create in Cloud"}</DenButton></div>
    </section>
  );
}
