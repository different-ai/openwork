"use client";

import { useEffect, useMemo, useState } from "react";
import { Cloud, X } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenSelect } from "../../_components/ui/select";
import { DenTextarea } from "../../_components/ui/textarea";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useOrgLlmProviders } from "./llm-provider-data";
import { useCreateCloudAutomation } from "./automation-data";

type Props = {
  onClose: () => void;
  onCreated: (automationId: string) => void;
};

export function CloudAutomationForm({ onClose, onCreated }: Props) {
  const { orgId, orgContext } = useOrgDashboard();
  const { llmProviders, busy, error } = useOrgLlmProviders(orgId, { scope: "usable" });
  const createAutomation = useCreateCloudAutomation();
  const models = useMemo(() => llmProviders.flatMap((provider) => provider.models.map((model) => ({
    key: `${provider.id}:${model.id}`,
    providerId: provider.source === "openwork" ? "openwork" : provider.id,
    providerName: provider.name,
    modelId: model.id,
    modelName: model.name,
  }))), [llmProviders]);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [time, setTime] = useState("09:00");
  const [modelKey, setModelKey] = useState("");
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const cloudEnabled = orgContext?.capabilities.cloud === true;

  useEffect(() => {
    if (!modelKey && models[0]) setModelKey(models[0].key);
  }, [modelKey, models]);

  const submit = async () => {
    const model = models.find((entry) => entry.key === modelKey);
    const [hourValue, minuteValue] = time.split(":");
    const hour = Number(hourValue);
    const minute = Number(minuteValue);
    if (!model || !name.trim() || !instructions.trim() || !Number.isInteger(hour) || !Number.isInteger(minute)) return;
    try {
      const created = await createAutomation.mutateAsync({
        name: name.trim(),
        schedule: { kind: "daily", timezone, hour, minute },
        action: {
          kind: "agent",
          instructions: instructions.trim(),
          model: { providerId: model.providerId, modelId: model.modelId },
        },
        executionTarget: "cloud",
      });
      onCreated(created.automation.id);
    } catch {
      // The mutation exposes the server's actionable message below.
    }
  };

  return (
    <section className="mt-6 rounded-2xl border border-sky-100 bg-sky-50/40 p-5">
      <div className="flex items-start justify-between gap-4">
        <div><h2 className="flex items-center gap-2 text-[14px] font-semibold text-gray-900"><Cloud className="h-4 w-4 text-sky-600" />New Cloud Automation</h2><p className="mt-1 text-[12px] text-gray-500">Runs in OpenWork Cloud even when your desktop is offline. A stopped Cloud container wakes automatically.</p></div>
        <button type="button" aria-label="Close Cloud Automation form" onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-white hover:text-gray-700"><X className="h-4 w-4" /></button>
      </div>
      {!cloudEnabled ? <p className="mt-4 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-[12px] text-amber-700">OpenWork Cloud is not enabled for this workspace.</p> : null}
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <label className="space-y-1.5 text-[12px] font-medium text-gray-700">Name<DenInput value={name} onChange={(event) => setName(event.target.value)} placeholder="Morning customer brief" maxLength={120} /></label>
        <label className="space-y-1.5 text-[12px] font-medium text-gray-700">Model<DenSelect value={modelKey} onChange={(event) => setModelKey(event.target.value)} disabled={busy || models.length === 0} aria-label="Automation model"><option value="">{busy ? "Loading models…" : "Select a model"}</option>{models.map((model) => <option key={model.key} value={model.key}>{model.providerName} · {model.modelName}</option>)}</DenSelect></label>
        <label className="space-y-1.5 text-[12px] font-medium text-gray-700 md:col-span-2">Instructions<DenTextarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={5} placeholder="Review my connected sources and prepare…" maxLength={100_000} /></label>
        <label className="space-y-1.5 text-[12px] font-medium text-gray-700">Run every day at<DenInput type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label>
        <div className="flex items-end text-[12px] text-gray-500">Timezone: {timezone}</div>
      </div>
      {error ? <p className="mt-3 text-[12px] text-red-600">{error}</p> : null}
      {createAutomation.error ? <p className="mt-3 text-[12px] text-red-600">{createAutomation.error.message}</p> : null}
      <div className="mt-5 flex justify-end gap-2"><DenButton variant="secondary" onClick={onClose}>Cancel</DenButton><DenButton loading={createAutomation.isPending} disabled={!cloudEnabled || !name.trim() || !instructions.trim() || !modelKey} onClick={() => void submit()}>Create in Cloud</DenButton></div>
    </section>
  );
}
