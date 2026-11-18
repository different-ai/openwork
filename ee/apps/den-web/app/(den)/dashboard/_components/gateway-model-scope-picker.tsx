"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { DenInput } from "../../_components/ui/input";
import { DenSkeleton } from "../../_components/ui/skeleton";

export type GatewayScopeModel = { id: string; name: string; source: string };

function Radio({ testId, checked, label, disabled, onSelect }: { testId: string; checked: boolean; label: string; disabled?: boolean; onSelect: () => void }) {
  return (
    <label className={`flex flex-1 cursor-pointer items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-[13px] ${checked ? "border-gray-200 bg-gray-50 text-gray-900" : "border-gray-200 bg-white text-gray-600"}`}>
      <input type="radio" name="gateway-models-scope" data-testid={testId} checked={checked} disabled={disabled} onChange={onSelect} className="h-4 w-4 accent-gray-900" />
      {label}
    </label>
  );
}

/**
 * The Models choice shared by AI providers: every model, or only the ones the
 * admin picks from a filterable list.
 */
export function GatewayModelScopePicker({
  allLabel, allowAll, onAllowAll, onPick, models, selected, onSelectedChange, icon, loading = false, unavailable = false, disabled = false,
}: {
  allLabel: string;
  allowAll: boolean;
  onAllowAll: () => void;
  onPick: () => void;
  models: GatewayScopeModel[];
  selected: string[];
  onSelectedChange: (modelIds: string[]) => void;
  icon: (model: GatewayScopeModel) => ReactNode;
  /** The model list is still loading. */
  loading?: boolean;
  /** The model list could not be loaded. */
  unavailable?: boolean;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? models.filter((model) => model.name.toLowerCase().includes(normalized) || model.id.toLowerCase().includes(normalized)) : models;
  }, [models, query]);
  const listDisabled = disabled || loading || unavailable || !models.length;

  return (
    <>
      <div className="mt-3 flex gap-2">
        <Radio testId="gateway-models-all" checked={allowAll} disabled={disabled} label={allLabel} onSelect={onAllowAll} />
        <Radio testId="gateway-models-pick" checked={!allowAll} disabled={disabled} label="Only the ones I pick" onSelect={onPick} />
      </div>
      {!allowAll ? (
        <div className="mt-3 rounded-[10px] bg-gray-50 p-2">
          <div className="flex items-center gap-3">
            <div className="w-[200px]"><DenInput type="search" icon={Search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter models" aria-label="Filter models" className="h-8 bg-white text-[12px]" /></div>
            {!loading && !unavailable ? <span className="text-[12px] text-gray-500" data-testid="gateway-models-count">{selected.length} of {models.length} selected</span> : null}
            <span className="ml-auto flex items-center gap-3 text-[12px]">
              <button type="button" data-testid="gateway-models-select-all" disabled={listDisabled} className="font-medium text-gray-700 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50" onClick={() => onSelectedChange(models.map((model) => model.id))}>Select all</button>
              <button type="button" data-testid="gateway-models-clear" disabled={listDisabled} className="font-medium text-gray-700 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50" onClick={() => onSelectedChange([])}>Clear</button>
            </span>
          </div>
          <ul className="mt-2 max-h-[320px] overflow-y-auto">
            {filtered.map((model) => {
              const checked = selected.includes(model.id);
              return (
                <li key={model.id}>
                  <label className="flex items-center gap-3 rounded-[8px] px-2 py-1.5 hover:bg-white">
                    <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onSelectedChange(checked ? selected.filter((id) => id !== model.id) : [...selected, model.id])} className="h-4 w-4 accent-emerald-600" data-testid={`gateway-model-${model.id}`} />
                    {icon(model)}
                    <span className="min-w-0 flex-1 truncate text-[13px] text-gray-900" title={model.id}>{model.name}</span>
                    <span className="text-[11px] text-gray-400">{model.source}</span>
                  </label>
                </li>
              );
            })}
            {loading ? Array.from({ length: 4 }, (_, index) => <li key={index} className="flex items-center gap-3 px-2 py-1.5" data-testid="gateway-models-loading"><DenSkeleton className="size-4" /><DenSkeleton className="size-5 rounded" /><DenSkeleton className="h-4 flex-1" /><DenSkeleton className="h-3 w-20" /></li>) : null}
            {!loading && !unavailable && models.length > 0 && !filtered.length ? <li className="px-2 py-3 text-[12px] text-gray-500" data-testid="gateway-models-filter-empty">No models match that filter. Try another name.</li> : null}
          </ul>
        </div>
      ) : null}
    </>
  );
}
