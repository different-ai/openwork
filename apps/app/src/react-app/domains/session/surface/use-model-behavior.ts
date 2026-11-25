import { useEffect, useMemo, useState } from "react";

import { getModelBehaviorSummary, sanitizeModelBehaviorValue } from "@/app/lib/model-behavior";
import type { ModelRef, ProviderListItem } from "@/app/types";
import { t } from "@/i18n";

type ProviderModel = ProviderListItem["models"][string];

export type ProviderCatalog = Record<string, Record<string, ProviderModel>>;

const emptyModelBehaviorOptions: { value: string | null; label: string }[] = [];

export type UseModelBehaviorInput = {
  providerList: { all: ProviderListItem[] } | undefined;
  defaultModel: ModelRef | null;
  modelVariant: string | null;
};

export function useModelBehavior(input: UseModelBehaviorInput) {
  const { providerList, defaultModel, modelVariant } = input;
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalog>({});

  useEffect(() => {
    if (!providerList?.all) return;
    const next: ProviderCatalog = {};
    for (const provider of providerList.all) {
      next[provider.id] = { ...(provider.models ?? {}) };
    }
    setProviderCatalog(next);
  }, [providerList]);

  const { modelVariantLabel, modelBehaviorOptions, modelVariantValue } = useMemo(() => {
    const variant = modelVariant ?? null;
    if (!defaultModel) {
      return {
        modelVariantLabel: t("settings.default_label"),
        modelBehaviorOptions: emptyModelBehaviorOptions,
        modelVariantValue: null,
      };
    }
    const model = providerCatalog[defaultModel.providerID]?.[defaultModel.modelID];
    const summary = getModelBehaviorSummary(defaultModel.providerID, model,
      model ? sanitizeModelBehaviorValue(defaultModel.providerID, model, variant) : variant);
    return {
      modelVariantLabel: summary.label,
      modelBehaviorOptions: summary.options,
      modelVariantValue: summary.value,
    };
  }, [defaultModel, modelVariant, providerCatalog]);

  return { providerCatalog, modelVariantLabel, modelBehaviorOptions, modelVariantValue };
}
