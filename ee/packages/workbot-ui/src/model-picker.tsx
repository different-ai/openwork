"use client";

import { Combobox } from "@base-ui/react/combobox";
import { Select } from "@base-ui/react/select";
import type { AutomationModelOption } from "@openwork/types/automation-models";
import type { AutomationModel } from "@openwork/types/automations";
import { ProviderIcon } from "@openwork/ui/provider-icon";
import { Check, ChevronDown, Cloud, Search } from "lucide-react";
import { useMemo } from "react";
import { OpenWorkMark } from "./mark";
import { workbotHost } from "./host";

/**
 * Which model an Automation uses, in Workbot's style: the current model with its provider's logo, and a list
 * of the models this member may use, grouped by provider with logos, searchable when the list is long.
 */

const SEARCH_THRESHOLD = 8;
const triggerClass = "flex h-9 w-full min-w-0 items-center gap-2 rounded-lg bg-[var(--wb-surface)] px-2 text-left text-[13px] shadow-[0_0_0_1px_var(--wb-ring)] hover:bg-[var(--wb-tray)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] disabled:opacity-60";
const popupClass = "workbot flex w-[var(--anchor-width)] max-w-[min(var(--available-width),calc(100vw-1rem))] max-h-[min(18rem,var(--available-height))] flex-col overflow-hidden rounded-lg bg-[var(--wb-surface)] text-[var(--wb-text)] shadow-[var(--wb-panel-shadow)] outline-none";
const listClass = "min-h-0 overflow-y-auto overscroll-contain p-1 scroll-py-1 outline-none";
const groupLabelClass = "truncate px-2 pb-1 pt-2 text-[11px] font-medium text-[var(--wb-muted)]";
const itemClass = "flex h-9 w-full min-w-0 shrink-0 cursor-default select-none items-center gap-2 rounded-md px-2 text-left text-[13px] text-[var(--wb-text)] outline-none data-[highlighted]:bg-[var(--wb-chip)] data-[selected]:font-medium";

function same(option: AutomationModelOption, model: AutomationModel | null) {
  return model !== null && option.providerId === model.providerId && option.modelId === model.modelId;
}

function modelKey(option: AutomationModelOption) {
  return `${option.providerId}/${option.modelId}`;
}

export function ModelLogo({ option, size = 14 }: { option: Pick<AutomationModelOption, "providerId" | "providerName" | "logoProviderId" | "accessKind">; size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-md bg-[var(--wb-surface)] text-[var(--wb-ink)] shadow-[0_0_0_1px_var(--wb-ring)]" style={{ width: size + 8, height: size + 8 }}>
      {/* The cloud default is "whatever this organization's cloud runs": a cloud, not a vendor. */}
      {option.accessKind === "cloud_default"
        ? workbotHost().calendarPolish === true ? <OpenWorkMark width={size} height={size} /> : <Cloud size={size} strokeWidth={1.75} aria-hidden />
        : <ProviderIcon providerId={option.logoProviderId ?? option.providerId} providerName={option.providerName} size={size} />}
    </span>
  );
}

/** One line for a model: logo, name and provider. Shows the raw ID when the model is no longer offered. */
export function ModelSummary({ model, options }: { model: AutomationModel; options: readonly AutomationModelOption[] }) {
  const option = options.find((candidate) => same(candidate, model));
  if (!option) return <span className="truncate text-[var(--wb-muted)]">{workbotHost().calendarPolish === true ? "Model no longer available" : `${model.providerId}/${model.modelId} · no longer available`}</span>;
  return (
    <span className="flex min-w-0 items-center gap-2" data-automation-model={modelKey(option)}>
      <ModelLogo option={option} size={12} />
      <span className="min-w-0 truncate">
        <span className="font-medium text-[var(--wb-text)]">{option.modelName}</span>
        {workbotHost().calendarPolish === true
          ? option.accessKind === "cloud_default" ? null : <span className="text-[var(--wb-muted)]"> ({option.providerName})</span>
          : <span className="text-[var(--wb-muted)]"> · {option.providerName}</span>}
      </span>
    </span>
  );
}

function ModelOptionContent({ option }: { option: AutomationModelOption }) {
  return (
    <>
      <ModelLogo option={option} size={12} />
      <span className="min-w-0 flex-1 truncate">{option.modelName}</span>
      {option.accessKind === "cloud_default" ? <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--wb-muted)] shadow-[inset_0_0_0_1px_var(--wb-ring)]">Default</span> : null}
    </>
  );
}

type ModelGroup = { provider: string; items: AutomationModelOption[] };

export function ModelPicker({ value, options, loading, onChange, label = "Model", side = "top" }: {
  value: AutomationModel | null;
  options: readonly AutomationModelOption[];
  loading?: boolean;
  onChange: (model: AutomationModel) => void;
  label?: string;
  /** Preferred opening side; the list flips or shrinks to fit the viewport. */
  side?: "top" | "bottom";
}) {
  const groups = useMemo(() => {
    const byProvider = new Map<string, AutomationModelOption[]>();
    for (const option of options) byProvider.set(option.providerName, [...(byProvider.get(option.providerName) ?? []), option]);
    return [...byProvider].map(([provider, items]) => ({ provider, items }));
  }, [options]);
  const current = options.find((option) => same(option, value)) ?? null;
  const disabled = loading && options.length === 0;
  const changeModel = (option: AutomationModelOption | null) => {
    if (option) onChange({ providerId: option.providerId, modelId: option.modelId, variant: null });
  };
  const triggerContent = (
    <>
      <span className="min-w-0 flex-1">
        {value ? <ModelSummary model={value} options={options} /> : <span className="text-[var(--wb-muted)]">{loading ? "Loading models…" : "No model available"}</span>}
      </span>
      <ChevronDown size={14} className="shrink-0 text-[var(--wb-muted)]" aria-hidden />
    </>
  );
  const positioning = {
    side,
    align: "start",
    sideOffset: 4,
    collisionPadding: 8,
    positionMethod: "fixed",
    collisionAvoidance: { side: "flip", align: "shift", fallbackAxisSide: "none" },
  } satisfies Combobox.Positioner.Props;

  // Short lists need Select's Home/End and typeahead, not an invisible combobox input (DESIGN P5).
  if (options.length <= SEARCH_THRESHOLD) {
    return (
      <Select.Root<AutomationModelOption>
        items={options.map((option) => ({ value: option, label: option.modelName }))}
        value={current}
        disabled={disabled}
        modal={false}
        itemToStringLabel={(option) => option.modelName}
        itemToStringValue={modelKey}
        isItemEqualToValue={(option, selected) => same(option, selected)}
        onValueChange={changeModel}
        onOpenChange={(_open, details) => { if (details.reason === "escape-key") details.event.stopPropagation(); }}
      >
        <Select.Trigger aria-label={label} className={triggerClass}>{triggerContent}</Select.Trigger>
        <Select.Portal>
          {/* The standalone headless primitive needs the same overlay layer as Workbot's dialogs. */}
          <Select.Positioner {...positioning} alignItemWithTrigger={false} className="z-50">
            <Select.Popup data-workbot-model-popup className={popupClass}>
              <Select.List aria-label={label} className={listClass}>
                {groups.map((group) => (
                  <Select.Group key={group.provider}>
                    <Select.GroupLabel className={groupLabelClass}>{group.provider}</Select.GroupLabel>
                    {group.items.map((option) => (
                      <Select.Item key={modelKey(option)} value={option} label={option.modelName} className={itemClass}>
                        <ModelOptionContent option={option} />
                        <Select.ItemIndicator className="shrink-0 text-[var(--wb-ink)]"><Check size={14} aria-hidden /></Select.ItemIndicator>
                      </Select.Item>
                    ))}
                  </Select.Group>
                ))}
                {options.length === 0 ? <p className="px-2 py-2 text-[12px] text-[var(--wb-muted)]">No models available.</p> : null}
              </Select.List>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    );
  }

  return (
    <Combobox.Root<AutomationModelOption>
      items={groups}
      value={current}
      disabled={disabled}
      autoHighlight
      itemToStringLabel={(option) => option.modelName}
      itemToStringValue={modelKey}
      isItemEqualToValue={(option, selected) => same(option, selected)}
      filter={(option, query) => `${option.modelName} ${option.providerName}`.toLowerCase().includes(query.trim().toLowerCase())}
      onValueChange={changeModel}
      onOpenChange={(_open, details) => { if (details.reason === "escape-key") details.event.stopPropagation(); }}
    >
      <Combobox.Trigger aria-label={label} className={triggerClass}>{triggerContent}</Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner {...positioning} className="z-50">
          <Combobox.Popup data-workbot-model-popup aria-label={label} className={popupClass}>
            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--wb-hairline)] px-2.5 focus-within:shadow-[inset_0_-1px_0_0_var(--wb-ink)]">
              <Search size={13} className="shrink-0 text-[var(--wb-faint)]" aria-hidden />
              <Combobox.Input placeholder="Search models" aria-label="Search models" className="h-8.5 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--wb-faint)]" />
            </div>
            <Combobox.Empty className="px-3 py-2 text-[12px] text-[var(--wb-muted)] empty:hidden">No models match.</Combobox.Empty>
            <Combobox.List aria-label={label} className={listClass}>
              {(group: ModelGroup) => (
                <Combobox.Group key={group.provider} items={group.items}>
                  <Combobox.GroupLabel className={groupLabelClass}>{group.provider}</Combobox.GroupLabel>
                  <Combobox.Collection>
                    {(option: AutomationModelOption) => (
                      <Combobox.Item key={modelKey(option)} value={option} className={itemClass}>
                        <ModelOptionContent option={option} />
                        <Combobox.ItemIndicator className="shrink-0 text-[var(--wb-ink)]"><Check size={14} aria-hidden /></Combobox.ItemIndicator>
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
