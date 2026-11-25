"use client";

import { WORKBOT_DEFAULT_MODEL_NAME, type WorkbotSettings } from "@openwork/types/den/workbot-settings";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import type { DenComboboxOption } from "../../_components/ui/combobox";
import { providerIconSlug } from "./library-models";

export function workbotDisplayName(brand: string | null | undefined): string {
  const trimmed = typeof brand === "string" ? brand.trim() : "";
  return trimmed && trimmed !== "OpenWork" ? trimmed.slice(0, 40) : "Workbot";
}

export function WorkbotModelMark({ id, provider: brand }: { id: string; provider?: string }) {
  const provider = brand ?? (id.includes("/") ? id.slice(0, id.indexOf("/")) : id);
  return (
    <DenBrandMark
      name={provider}
      simpleIconSlug={providerIconSlug(provider)}
      className="h-5 w-5 rounded-[5px] border-gray-200"
      imageClassName="h-3.5 w-3.5"
    />
  );
}

export function effectiveWorkbotModel(settings: WorkbotSettings): string | null {
  return settings.model ?? settings.defaultModel;
}

export function isWorkbotModelListed(settings: WorkbotSettings, id: string | null): boolean {
  return Boolean(id) && settings.models.some((entry) => entry.id === id);
}

export function workbotModelName(settings: WorkbotSettings, id: string | null, saved: string | null = settings.model): string {
  if (!id) return "No model";
  const listed = settings.models.find((entry) => entry.id === id)?.name;
  if (listed) return listed;
  return !saved && id === settings.defaultModel ? WORKBOT_DEFAULT_MODEL_NAME : "Unavailable model";
}

export function workbotModelOptions(
  settings: WorkbotSettings,
  current: string | null = effectiveWorkbotModel(settings),
  saved: string | null = settings.model,
): DenComboboxOption[] {
  const missing = current && !isWorkbotModelListed(settings, current)
    ? [{ value: current, label: workbotModelName(settings, current, saved), description: settings.gatewayModels ? "Not available to you" : "No longer available" }]
    : [];
  return [
    ...missing,
    ...settings.models.map((entry) => ({ value: entry.id, label: entry.name, keywords: [entry.id], icon: <WorkbotModelMark id={entry.id} provider={entry.provider} /> })),
  ];
}
