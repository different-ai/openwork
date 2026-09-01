import { useEffect, useMemo, useState } from "react";
import type { CoworkerSummary, RuntimeInfo } from "@/lib/bridge";
import {
  createCoworkerThreads,
  type EngineModelCatalog,
  type EngineModelOption,
} from "@/lib/threads";
import { Button, ErrorNote, Field, StatusDot, inputClass } from "@/ui/kit";

export type ModelSelection = { model: string; modelVariant: string };

function selectedDescription(option: EngineModelOption | undefined, value: string): string {
  if (!value) return "OpenWork chooses the configured engine default.";
  if (!option) return "This saved model is not currently available from a connected provider.";
  return `${option.providerLabel} · ${option.modelId}`;
}

export function ModelPicker({
  runtime,
  coworker,
  value,
  modelVariant,
  onChange,
  compact = false,
}: {
  runtime: RuntimeInfo;
  coworker: CoworkerSummary;
  value: string;
  modelVariant: string;
  onChange: (selection: ModelSelection) => void;
  compact?: boolean;
}) {
  const threads = useMemo(
    () =>
      coworker.workspaceId
        ? createCoworkerThreads({
            serverUrl: runtime.serverUrl,
            workspaceId: coworker.workspaceId,
            token: runtime.ownerToken,
          })
        : null,
    [coworker.workspaceId, runtime.ownerToken, runtime.serverUrl],
  );
  const [catalog, setCatalog] = useState<EngineModelCatalog>({ models: [], connectedProviderIds: [] });
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(!compact);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    if (!threads || !runtime.engineManaged) return;
    setLoading(true);
    setError("");
    try {
      setCatalog(await threads.listModelCatalog());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [threads, runtime.engineManaged]);

  const selected = catalog.models.find((option) => option.id === value);
  const visible = catalog.models.filter((option) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${option.providerLabel} ${option.providerId} ${option.modelLabel} ${option.modelId} ${option.family}`
      .toLowerCase()
      .includes(needle);
  });
  const groups = Array.from(
    visible.reduce((byProvider, option) => {
      const group = byProvider.get(option.providerId) ?? { label: option.providerLabel, models: [] };
      group.models.push(option);
      byProvider.set(option.providerId, group);
      return byProvider;
    }, new Map<string, { label: string; models: EngineModelOption[] }>()),
  );
  const variants = selected?.variants ?? [];

  function selectModel(model: EngineModelOption | null) {
    onChange({
      model: model?.id ?? "",
      modelVariant: model?.variants.includes(modelVariant) ? modelVariant : "",
    });
    if (compact) setOpen(false);
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-xl border border-line bg-panel px-3 py-3 text-left transition-colors hover:border-white/20 hover:bg-white/5"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-ink">
          <StatusDot tone={selected || !value ? "mint" : "amber"} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-snow">
            {selected?.modelLabel || (value ? value : "Engine default")}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-mist">
            {selectedDescription(selected, value)}
          </span>
        </span>
        <span className="text-xs text-mist" aria-hidden="true">{open ? "⌃" : "⌄"}</span>
      </button>

      {open ? (
        <div className="overflow-hidden rounded-2xl border border-line bg-ink">
          <div className="flex items-center gap-2 border-b border-line p-2.5">
            <input
              className={`${inputClass} min-w-0 flex-1 bg-panel py-2 text-xs`}
              aria-label="Search connected models"
              placeholder="Search connected models"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button variant="ghost" className="shrink-0 text-xs" disabled={loading} onClick={() => void refresh()}>
              {loading ? "…" : "Refresh"}
            </Button>
          </div>
          <div className="max-h-64 overflow-y-auto p-2">
            <button
              type="button"
              className={`flex w-full items-start gap-2 rounded-xl px-2.5 py-2.5 text-left ${!value ? "bg-white/8" : "hover:bg-white/5"}`}
              onClick={() => selectModel(null)}
            >
              <StatusDot tone={!value ? "mint" : "mist"} />
              <span>
                <span className="block text-xs font-semibold text-snow">Engine default</span>
                <span className="mt-0.5 block text-[11px] text-mist">Follow the current OpenWork default.</span>
              </span>
            </button>

            {value && !selected ? (
              <div className="mt-1 rounded-xl bg-amber/8 px-2.5 py-2 text-[11px] leading-relaxed text-amber">
                Saved selection {value} is unavailable. Choose a connected model or use the engine default.
              </div>
            ) : null}

            {groups.map(([providerId, group]) => (
              <div key={providerId} className="mt-2 border-t border-line pt-2">
                <p className="px-2 pb-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-mist">
                  {group.label}
                </p>
                {group.models.map((option) => (
                  <button
                    type="button"
                    key={option.id}
                    className={`flex w-full items-start gap-2 rounded-xl px-2.5 py-2 text-left ${option.id === value ? "bg-white/8" : "hover:bg-white/5"}`}
                    onClick={() => selectModel(option)}
                  >
                    <StatusDot tone={option.id === value ? "mint" : "mist"} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-medium text-snow">{option.modelLabel}</span>
                        {option.isProviderDefault ? (
                          <span className="shrink-0 rounded-full bg-white/7 px-1.5 py-0.5 text-[8px] uppercase tracking-wide text-mist">Default</span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-mist">{option.modelId}</span>
                    </span>
                  </button>
                ))}
              </div>
            ))}

            {!loading && runtime.engineManaged && catalog.models.length === 0 ? (
              <p className="p-3 text-xs leading-relaxed text-mist">
                No connected provider models are available yet. The engine default remains usable after a provider is configured in OpenWork.
              </p>
            ) : null}
            {!runtime.engineManaged ? (
              <p className="p-3 text-xs leading-relaxed text-rose">Start the local agent engine to read connected models.</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {value && variants.length > 0 ? (
        <Field label="Reasoning">
          <select
            className={`${inputClass} bg-panel`}
            value={modelVariant}
            onChange={(event) => onChange({ model: value, modelVariant: event.target.value })}
          >
            <option value="">Provider default</option>
            {variants.map((variant) => (
              <option key={variant} value={variant}>{variant.slice(0, 1).toUpperCase() + variant.slice(1)}</option>
            ))}
          </select>
        </Field>
      ) : null}

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <p className="text-[11px] leading-relaxed text-mist">
        Only models from providers connected to this OpenWork engine are shown.
      </p>
    </div>
  );
}
