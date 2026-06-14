// Provider catalog cache + behavior (reasoning/thinking variant) options for
// the active default model — what the composer renders as its variant pill.
// Extracted verbatim from session-route.tsx; the catalog is also consumed by
// the model picker's lazy option loader until that moves into its own hook.
import { useEffect, useMemo, useState } from "react";

import { getModelBehaviorSummary } from "@/app/lib/model-behavior";
import type { ModelRef, ProviderListItem } from "@/app/types";
import { t } from "@/i18n";

type ProviderModel = ProviderListItem["models"][string];

export type ProviderCatalog = Record<string, Record<string, ProviderModel>>;

const emptyModelBehaviorOptions: { value: string | null; label: string }[] = [];

export type UseModelBehaviorInput = {
  /** Result of useProviderListQuery().data — refreshed by the route. */
  providerList: { all: ProviderListItem[] } | undefined;
  defaultModel: ModelRef | null;
  modelVariant: string | null;
};

export function useModelBehavior(input: UseModelBehaviorInput) {
  const { providerList, defaultModel, modelVariant } = input;
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalog>({});

  // Prefetch the full provider catalog once so `getModelBehaviorSummary` has
  // everything it needs to expose the reasoning/thinking variants the active
  // model supports — without waiting for the model picker to open. Cached
  // as providerID → modelID → ProviderModel.
  useEffect(() => {
    if (!providerList?.all) return;
    const next: ProviderCatalog = {};
    for (const provider of providerList.all) {
      next[provider.id] = { ...(provider.models ?? {}) };
    }
    setProviderCatalog(next);
  }, [providerList]);

  // Compute behavior (reasoning/thinking variant) options for the current
  // default model.
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
    if (!model) {
      return {
        modelVariantLabel: variant ?? t("settings.default_label"),
        modelBehaviorOptions: emptyModelBehaviorOptions,
        modelVariantValue: variant,
      };
    }
    const summary = getModelBehaviorSummary(defaultModel.providerID, model, variant);
    return {
      modelVariantLabel: summary.label,
      modelBehaviorOptions: summary.options,
      modelVariantValue: summary.value,
    };
  }, [defaultModel, modelVariant, providerCatalog]);

  return { providerCatalog, modelVariantLabel, modelBehaviorOptions, modelVariantValue };
}
