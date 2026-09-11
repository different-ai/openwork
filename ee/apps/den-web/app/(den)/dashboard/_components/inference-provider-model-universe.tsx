"use client";

import { DenNotice } from "../../_components/ui/notice";
import { DenSwitch } from "../../_components/ui/switch";
import { ProviderModelPicker, type ProviderModelOption } from "./llm-provider-pickers";

export function GatewayModelUniverse({ models, allowAllModels, modelIds, onChange, disabled = false, warning }: {
  models: ProviderModelOption[] | null;
  allowAllModels: boolean;
  modelIds: string[];
  onChange: (allowAllModels: boolean, modelIds: string[]) => void;
  disabled?: boolean;
  warning?: string | null;
}) {
  return <>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 className="text-xl font-semibold">Model universe</h2>
        <p className="mt-2 text-gray-500">Select which models are allowed across your whole organization</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-sm text-gray-600">Allow all models</span>
        <DenSwitch
          checked={allowAllModels}
          disabled={disabled || !models}
          aria-label="Allow all models"
          onChange={(checked) => onChange(checked, modelIds.length ? modelIds : (models ?? []).map((model) => model.id))}
        />
      </div>
    </div>
    {warning ? <DenNotice className="mt-4" tone="warning" message={warning} /> : null}
    <fieldset disabled={disabled || !models} className="min-w-0">
      {!allowAllModels ? <>
        <p className="mt-4 text-sm text-gray-500">Select at least one model. Removing a model also removes it from every model group when you save.</p>
        <ProviderModelPicker
          layout="cards"
          models={models ? [...models, ...modelIds.filter((id) => !models.some((model) => model.id === id)).map((id) => ({ id, name: id }))] : null}
          selectedModelIds={modelIds}
          onChange={(selected) => onChange(false, selected)}
          emptyLabel="The provider catalog must be loaded before selecting models."
        />
      </> : null}
    </fieldset>
  </>;
}
