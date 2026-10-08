"use client";

import type { AutomationModelOption } from "@openwork/types/automation-models";
import type { AutomationModel } from "@openwork/types/automations";
import { ProviderIcon } from "@openwork/ui/provider-icon";
import { Check, ChevronDown, Cloud, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * Which model an Automation uses, in Workbot's style: the current model with its provider's logo, and a list
 * of the models this member may use, grouped by provider with logos, searchable when the list is long.
 */

const SEARCH_THRESHOLD = 8;

function same(option: AutomationModelOption, model: AutomationModel | null) {
  return model !== null && option.providerId === model.providerId && option.modelId === model.modelId;
}

export function ModelLogo({ option, size = 14 }: { option: Pick<AutomationModelOption, "providerId" | "providerName" | "logoProviderId" | "accessKind">; size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-md bg-white text-[#011627] shadow-[0_0_0_1px_#0116271A]" style={{ width: size + 8, height: size + 8 }}>
      {/* The cloud default is "whatever this organization's cloud runs": a cloud, not a vendor. */}
      {option.accessKind === "cloud_default"
        ? <Cloud size={size} strokeWidth={1.75} aria-hidden />
        : <ProviderIcon providerId={option.logoProviderId ?? option.providerId} providerName={option.providerName} size={size} />}
    </span>
  );
}

/** One line for a model: logo, name and provider. Shows the raw ID when the model is no longer offered. */
export function ModelSummary({ model, options }: { model: AutomationModel; options: readonly AutomationModelOption[] }) {
  const option = options.find((candidate) => same(candidate, model));
  if (!option) return <span className="truncate text-[#687076]">{model.providerId}/{model.modelId} · no longer available</span>;
  return (
    <span className="flex min-w-0 items-center gap-2" data-automation-model={`${option.providerId}/${option.modelId}`}>
      <ModelLogo option={option} size={12} />
      <span className="min-w-0 truncate">
        <span className="font-medium text-black">{option.modelName}</span>
        <span className="text-[#687076]"> · {option.providerName}</span>
      </span>
    </span>
  );
}

export function ModelPicker({ value, options, loading, onChange, label = "Model", side = "top" }: {
  value: AutomationModel | null;
  options: readonly AutomationModelOption[];
  loading?: boolean;
  onChange: (model: AutomationModel) => void;
  label?: string;
  /** Which way the list opens; up by default, since the picker sits at the bottom of cards and dialogs. */
  side?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listId = useId();
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? options.filter((option) => `${option.modelName} ${option.providerName}`.toLowerCase().includes(needle)) : options;
  }, [options, query]);
  const groups = useMemo(() => {
    const byProvider = new Map<string, AutomationModelOption[]>();
    for (const option of shown) byProvider.set(option.providerName, [...(byProvider.get(option.providerName) ?? []), option]);
    return [...byProvider.entries()];
  }, [shown]);
  const current = options.find((option) => same(option, value)) ?? null;

  return (
    <div ref={root} className="relative" onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={loading && options.length === 0}
        onClick={() => setOpen((next) => !next)}
        className="flex h-9 w-full items-center gap-2 rounded-lg bg-white px-2 text-left text-[13px] shadow-[0_0_0_1px_#0116271F] hover:bg-[#F8F9FA] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] disabled:opacity-60"
      >
        <span className="min-w-0 flex-1">
          {value ? <ModelSummary model={value} options={options} /> : <span className="text-[#687076]">{loading ? "Loading models…" : "No model available"}</span>}
        </span>
        <ChevronDown size={14} className="shrink-0 text-[#687076]" aria-hidden />
      </button>
      {open ? (
        <div className={`absolute inset-x-0 z-10 flex ${side === "top" ? "bottom-full mb-1" : "top-full mt-1"} max-h-72 flex-col overflow-hidden rounded-lg bg-white shadow-[0_0_0_1px_#0116270D,0_12px_32px_-12px_#01162740]`}>
          {options.length > SEARCH_THRESHOLD ? (
            <label className="flex items-center gap-2 border-b border-[#0116270F] px-2.5">
              <Search size={13} className="shrink-0 text-[#9BA1A6]" aria-hidden />
              <input autoFocus value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search models" aria-label="Search models" className="h-8.5 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[#9BA1A6]" />
            </label>
          ) : null}
          <div id={listId} role="listbox" aria-label={label} className="overflow-y-auto p-1">
            {groups.length === 0 ? <p className="px-2 py-2 text-[12px] text-[#687076]">No models match.</p> : null}
            {groups.map(([provider, models]) => (
              <div key={provider} role="group" aria-label={provider}>
                <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[11px] font-medium text-[#687076]">
                  {provider}
                </div>
                {models.map((option) => {
                  const selected = same(option, current);
                  return (
                    <button
                      key={`${option.providerId}/${option.modelId}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => { onChange({ providerId: option.providerId, modelId: option.modelId, variant: null }); setOpen(false); setQuery(""); }}
                      className={`flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-[#F4F6F7] focus-visible:outline-none focus-visible:bg-[#F4F6F7] ${selected ? "font-medium text-black" : "text-[#11181C]"}`}
                    >
                      <ModelLogo option={option} size={12} />
                      <span className="min-w-0 flex-1 truncate">{option.modelName}</span>
                      {option.accessKind === "cloud_default" ? <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-[#687076] shadow-[inset_0_0_0_1px_#0116271A]">Default</span> : null}
                      {selected ? <Check size={14} className="shrink-0 text-[#011627]" aria-hidden /> : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
