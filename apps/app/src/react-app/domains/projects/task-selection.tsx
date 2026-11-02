/** @jsxImportSource react */
import { useMemo, useState } from "react";

import { getModelBehaviorSummary, sanitizeModelBehaviorValue } from "@/app/lib/model-behavior";
import type { ModelRef } from "@/app/types";
import type { ProviderCatalog } from "@/react-app/domains/session/surface/use-model-behavior";

/** Model/variant/agent chosen before a session exists; the route remembers it
 * on the created session through the same per-session stores the composer
 * uses. Null model means "workspace default"; null agent means prefs. */
export type TaskSelection = {
  model: ModelRef | null;
  variant: string | null;
  agent: string | null;
};

export function useTaskSelection(providerCatalog: ProviderCatalog, connectedProviderIds: string[]) {
  const [selectedModel, setSelectedModel] = useState<ModelRef | null>(null);
  const [variant, setVariant] = useState<string | null>(null);
  const [agent, setAgent] = useState<string | null>(null);

  const modelGroups = useMemo(() => connectedProviderIds
    .map((providerId) => ({ providerId, models: Object.keys(providerCatalog[providerId] ?? {}) }))
    .filter((group) => group.models.length > 0), [connectedProviderIds, providerCatalog]);

  // Thinking/reasoning options for the selected model, straight from the
  // model's behavior metadata — the same source the main composer's pill uses.
  const variantOptions = useMemo(() => {
    if (!selectedModel) return [] as Array<{ value: string; label: string }>;
    const model = providerCatalog[selectedModel.providerID]?.[selectedModel.modelID];
    const summary = getModelBehaviorSummary(
      selectedModel.providerID,
      model,
      sanitizeModelBehaviorValue(selectedModel.providerID, model, variant),
    );
    const options: Array<{ value: string; label: string }> = [];
    for (const option of summary.options ?? []) {
      if (typeof option.value === "string") options.push({ value: option.value, label: option.label });
    }
    return options;
  }, [providerCatalog, selectedModel, variant]);

  const selectModel = (value: string) => {
    if (!value) {
      setSelectedModel(null);
      setVariant(null);
      return;
    }
    const separator = value.indexOf("|");
    setSelectedModel({ providerID: value.slice(0, separator), modelID: value.slice(separator + 1) });
    setVariant(null);
  };

  return {
    modelGroups,
    selectedModel, selectModel,
    variant, setVariant, variantOptions,
    agent, setAgent,
  };
}

/** The three compact selects (model / thinking / agent) shared by the project
 * detail composer and the Design page. */
export function TaskSelectionSelects({ modelGroups, selectedModel, selectModel, variant, setVariant, variantOptions, agent, setAgent, agents }: {
  modelGroups: Array<{ providerId: string; models: string[] }>;
  selectedModel: ModelRef | null;
  selectModel: (value: string) => void;
  variant: string | null;
  setVariant: (value: string | null) => void;
  variantOptions: Array<{ value: string; label: string }>;
  agent: string | null;
  setAgent: (value: string | null) => void;
  agents: string[];
}) {
  return (
    <>
      <select
        value={selectedModel ? `${selectedModel.providerID}|${selectedModel.modelID}` : ""}
        onChange={(event) => selectModel(event.target.value)}
        aria-label="Modelo"
        className="h-7 max-w-44 rounded-md border border-border bg-background px-2 text-xs text-foreground"
      >
        <option value="">Modelo predeterminado</option>
        {modelGroups.map((group) => (
          <optgroup key={group.providerId} label={group.providerId}>
            {group.models.map((modelId) => (
              <option key={modelId} value={`${group.providerId}|${modelId}`}>{modelId}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <select
        value={variant ?? ""}
        onChange={(event) => setVariant(event.target.value || null)}
        disabled={!selectedModel || variantOptions.length === 0}
        aria-label="Pensamiento"
        title={!selectedModel ? "Elige un modelo para ajustar el pensamiento" : "Nivel de pensamiento"}
        className="h-7 max-w-32 rounded-md border border-border bg-background px-2 text-xs text-foreground disabled:opacity-50"
      >
        <option value="">{selectedModel ? "Predeterminado" : "Pensamiento"}</option>
        {variantOptions.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <select
        value={agent ?? ""}
        onChange={(event) => setAgent(event.target.value || null)}
        aria-label="Agente"
        className="h-7 max-w-32 rounded-md border border-border bg-background px-2 text-xs text-foreground"
      >
        <option value="">Agente predeterminado</option>
        {agents.map((name) => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>
    </>
  );
}
