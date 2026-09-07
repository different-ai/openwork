import { useCallback, useEffect, useMemo, useState } from "react";
import type { CoworkerSummary, ModelChosenBy, ProviderSyncRun, RuntimeInfo } from "@/lib/bridge";
import { describeSkippedProvider, type DenSession } from "@/lib/den";
import { carryVariant, describeModelPick, previewAutomaticChoice, type ModelMode } from "@/lib/model-choice";
import {
  createCoworkerThreads,
  modelSourceLabel,
  type EngineModelCatalog,
  type EngineModelOption,
} from "@/lib/threads";
import { Button, ErrorNote, Field, StatusDot, inputClass } from "@/ui/kit";
import { InlineLoader } from "@/ui/brand";

export type ModelSelection = { model: string; modelVariant: string; modelMode: ModelMode };

const EMPTY_CATALOG: EngineModelCatalog = { models: [], connectedProviderIds: [], cloud: null };

export const AUTOMATIC_LABEL = "Automatic";
export const AUTOMATIC_BLURB = "Picks a quick, standard, or deep model for each message.";

function selectedDescription(option: EngineModelOption | undefined, value: string): string {
  if (!value) return "Uses OpenWork's default AI model."
  if (!option) return "This saved model is not currently available from a connected provider.";
  return `${option.providerLabel} · ${option.modelId} · ${modelSourceLabel(option.source)}`;
}

/**
 * What Automatic would do right now, in one line: "Quick GPT-5 mini · Standard
 * GPT-5 · Deep GPT-5 pro". Falls back to the blurb until the catalog is read.
 */
export function describeAutomaticChoice(catalog: Pick<EngineModelCatalog, "models">, standard: string): string {
  const preview = previewAutomaticChoice(catalog, standard);
  if (!preview.standard) return AUTOMATIC_BLURB;
  const parts = [
    `Quick ${preview.quick?.modelLabel ?? preview.standard.modelLabel}`,
    `Standard ${preview.standard.modelLabel}`,
    `Deep ${preview.deep?.modelLabel ?? preview.standard.modelLabel}`,
  ];
  return parts.join(" · ");
}

function SourceTag({ source }: { source: EngineModelOption["source"] }) {
  return (
    <span
      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.08em] ${
        source === "cloud" ? "bg-spark/14 text-[#b8caff]" : "bg-white/7 text-mist"
      }`}
      data-testid={`model-source-${source}`}
    >
      {modelSourceLabel(source)}
    </span>
  );
}

export function ModelPicker({
  runtime,
  session,
  coworker,
  value,
  modelVariant,
  modelMode = "fixed",
  onChange,
  onSyncProviders,
  onConnect,
  compact = false,
  chosenBy = "",
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  coworker: CoworkerSummary;
  value: string;
  modelVariant: string;
  /** `auto`: the coworker picks a lane per message around `value`; `fixed`: `value` every time. */
  modelMode?: ModelMode;
  onChange: (selection: ModelSelection) => void;
  /** Re-read the signed-in account's providers before re-listing models. */
  onSyncProviders?: () => Promise<ProviderSyncRun>;
  /** Offered in local mode so organization models can be added without leaving setup. */
  onConnect?: () => void;
  compact?: boolean;
  /** Who chose the current model; the app's own pick gets one plain line saying so and why. */
  chosenBy?: ModelChosenBy;
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
  const [catalog, setCatalog] = useState<EngineModelCatalog>(EMPTY_CATALOG);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(!compact);
  const [loading, setLoading] = useState(false);
  const [syncNote, setSyncNote] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async (options: { sync?: boolean } = {}) => {
    if (!threads || !runtime.engineManaged) return;
    setLoading(true);
    setError("");
    try {
      if (options.sync && session && onSyncProviders) {
        const run = await onSyncProviders();
        setSyncNote(
          run.status === "failed"
            ? `OpenWork provider refresh failed: ${run.message || "unknown error"}`
            : run.status === "applied"
              ? "OpenWork providers updated."
              : "",
        );
      }
      setCatalog(await threads.listModelCatalog());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [onSyncProviders, runtime.engineManaged, session, threads]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      const group = byProvider.get(option.providerId) ?? { label: option.providerLabel, source: option.source, models: [] };
      group.models.push(option);
      byProvider.set(option.providerId, group);
      return byProvider;
    }, new Map<string, { label: string; source: EngineModelOption["source"]; models: EngineModelOption[] }>()),
  );
  const variants = selected?.variants ?? [];
  const cloudModelCount = catalog.models.filter((option) => option.source === "cloud").length;
  const skipped = catalog.cloud?.skippedProviders ?? [];
  const reloadPending = catalog.cloud?.reloadPending === true;
  const lastRunFailed = catalog.cloud?.lastRun?.status === "failed" ? catalog.cloud.lastRun : null;

  const automatic = modelMode === "auto";
  const automaticLine = automatic ? describeAutomaticChoice(catalog, value) : "";

  /** A model row: that model, every time. */
  function selectModel(model: EngineModelOption | null) {
    onChange({
      model: model?.id ?? "",
      modelVariant: carryVariant(modelVariant, model),
      modelMode: "fixed",
    });
    if (compact) setOpen(false);
  }

  /** The Automatic row: lanes around the current model (or the recommendation when none is saved). */
  function selectAutomatic() {
    onChange({ model: value, modelVariant, modelMode: "auto" });
    if (compact) setOpen(false);
  }

  return (
    <div className="space-y-3" data-testid="model-picker" data-model-mode={modelMode}>
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-xl border border-line bg-panel px-3 py-3 text-left transition-colors hover:border-white/20 hover:bg-white/5"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-ink">
          <StatusDot tone={automatic || selected || !value ? "mint" : "amber"} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-snow" data-testid="model-picker-current">
            {automatic ? AUTOMATIC_LABEL : selected?.modelLabel || (value ? value : "Default AI model")}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-mist" data-testid="model-picker-current-detail">
            {automatic ? automaticLine : selectedDescription(selected, value)}
          </span>
        </span>
        <span className="text-xs text-mist" aria-hidden="true">{open ? "⌃" : "⌄"}</span>
      </button>
      {chosenBy === "app" && selected ? (
        <p className="text-[11px] leading-relaxed text-mist" data-testid="model-chosen-for-you">{describeModelPick(selected)}</p>
      ) : null}

      {open ? (
        <div className="overflow-hidden rounded-2xl border border-line bg-ink">
          <div className="flex items-center gap-2 border-b border-line p-2.5">
            <input
              className={`${inputClass} min-w-0 flex-1 bg-panel py-2 text-xs`}
              aria-label="Search AI models"
              placeholder="Search AI models"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button
              aria-busy={loading}
              variant="ghost"
              className="shrink-0 text-xs"
              disabled={loading}
              title={session ? "Refresh your OpenWork providers and the available AI models" : "Refresh the available AI models"}
              onClick={() => void refresh({ sync: true })}
            >
              {loading ? "Refreshing" : "Refresh"}
            </Button>
          </div>
          <div className="max-h-64 overflow-y-auto p-2">
            <button
              type="button"
              className={`flex w-full items-start gap-2 rounded-xl px-2.5 py-2.5 text-left ${automatic ? "bg-white/8" : "hover:bg-white/5"}`}
              data-testid="model-option-automatic"
              aria-pressed={automatic}
              onClick={selectAutomatic}
            >
              <StatusDot tone={automatic ? "mint" : "mist"} />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold text-snow">{AUTOMATIC_LABEL}</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-mist">
                  {AUTOMATIC_BLURB} A greeting or a one-line question gets a fast model, ordinary work the standard one, research, plans, drafts, and code a reasoning model — from the same provider, so nothing surprising is billed. Your own words win: “quickly” or “think carefully”.
                </span>
                {catalog.models.length > 0 ? (
                  <span className="mt-1 block text-[11px] text-mist/80" data-testid="model-option-automatic-preview">
                    {describeAutomaticChoice(catalog, value)}
                    {selected ? " · Pick a model below, then Automatic again, to change the standard one." : ""}
                  </span>
                ) : null}
              </span>
            </button>

            <button
              type="button"
              className={`mt-1 flex w-full items-start gap-2 rounded-xl px-2.5 py-2.5 text-left ${!automatic && !value ? "bg-white/8" : "hover:bg-white/5"}`}
              onClick={() => selectModel(null)}
            >
              <StatusDot tone={!automatic && !value ? "mint" : "mist"} />
              <span>
                <span className="block text-xs font-semibold text-snow">Default AI model</span>
                <span className="mt-0.5 block text-[11px] text-mist">Follow the current OpenWork default, every time.</span>
              </span>
            </button>

            {value && !selected ? (
              <div className="mt-1 rounded-xl bg-amber/8 px-2.5 py-2 text-[11px] leading-relaxed text-amber" data-testid="model-unavailable">
                Saved selection {value} is unavailable. Choose a connected AI model or use the default.
              </div>
            ) : null}

            {groups.map(([providerId, group]) => (
              <div key={providerId} className="mt-2 border-t border-line pt-2" data-testid={`model-provider-${providerId}`}>
                <p className="flex items-center gap-2 px-2 pb-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-mist">
                  <span className="truncate">{group.label}</span>
                  <SourceTag source={group.source} />
                </p>
                {group.models.map((option) => (
                  <button
                    type="button"
                    key={option.id}
                    className={`flex w-full items-start gap-2 rounded-xl px-2.5 py-2 text-left ${option.id === value && !automatic ? "bg-white/8" : "hover:bg-white/5"}`}
                    onClick={() => selectModel(option)}
                  >
                    <StatusDot tone={option.id === value && !automatic ? "mint" : "mist"} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-medium text-snow">{option.modelLabel}</span>
                        {option.isProviderDefault ? (
                          <span className="shrink-0 rounded-full bg-white/7 px-1.5 py-0.5 text-[8px] uppercase tracking-wide text-mist">Default</span>
                        ) : null}
                        {automatic && option.id === value ? (
                          <span className="shrink-0 rounded-full bg-spark/14 px-1.5 py-0.5 text-[8px] uppercase tracking-wide text-[#b8caff]" data-testid="model-standard-tag">Standard</span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-mist">{option.modelId}</span>
                    </span>
                  </button>
                ))}
              </div>
            ))}

            {skipped.length > 0 ? (
              <div className="mt-2 border-t border-line pt-2" data-testid="model-skipped-providers">
                <p className="px-2 pb-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-mist">Granted, not usable here yet</p>
                {skipped.map((provider) => (
                  <p key={provider.providerId} className="px-2.5 py-1.5 text-[11px] leading-relaxed text-mist">
                    <span className="font-medium text-snow/85">{provider.name}</span> — {describeSkippedProvider(provider.reason)}
                  </p>
                ))}
              </div>
            ) : null}

            {loading && catalog.models.length === 0 ? (
              <div className="p-4 text-xs text-mist"><InlineLoader label="Reading AI models" /></div>
            ) : null}

            {!loading && runtime.engineManaged && catalog.models.length === 0 ? (
              <p className="p-3 text-xs leading-relaxed text-mist">
                No AI models are connected yet. Connect a provider in OpenWork, then refresh.
              </p>
            ) : null}
            {!runtime.engineManaged ? (
              <p className="p-3 text-xs leading-relaxed text-rose">AI is unavailable, so models cannot be listed right now.</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {value && variants.length > 0 ? (
        <Field label={automatic ? "Exact thinking effort for the standard model (optional)" : "Exact thinking effort (optional)"}>
          <select
            className={`${inputClass} bg-panel`}
            value={modelVariant}
            title="Fixes one effort for every turn. On Model default, the effort dial decides per turn."
            onChange={(event) => onChange({ model: value, modelVariant: event.target.value, modelMode })}
          >
            <option value="">Model default — the dial decides</option>
            {variants.map((variant) => (
              <option key={variant} value={variant}>{variant.slice(0, 1).toUpperCase() + variant.slice(1)}</option>
            ))}
          </select>
        </Field>
      ) : null}

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {lastRunFailed ? (
        <p className="text-[11px] leading-relaxed text-amber" data-testid="model-sync-failed">
          OpenWork could not refresh your providers{lastRunFailed.message ? `: ${lastRunFailed.message}` : "."} Models listed under OpenWork Cloud may be stale.
        </p>
      ) : null}
      {reloadPending ? (
        <p className="text-[11px] leading-relaxed text-mist">New OpenWork providers appear once current work finishes.</p>
      ) : null}
      {syncNote ? <p className="text-[11px] leading-relaxed text-mist">{syncNote}</p> : null}
      <p className="text-[11px] leading-relaxed text-mist" data-testid="model-picker-summary">
        {session
          ? cloudModelCount > 0
            ? `${cloudModelCount} model${cloudModelCount === 1 ? "" : "s"} come from your OpenWork account (${session.orgName || session.userEmail || "signed in"}); the rest are configured on this Mac.`
            : `Signed in as ${session.orgName || session.userEmail || "your OpenWork account"}, but no organization models are available here yet. Refresh after your organization grants a provider.`
          : "Only AI models from connected providers are shown."}
        {!session && onConnect ? (
          <>
            {" "}
            <button type="button" className="font-medium text-spark hover:underline" onClick={onConnect}>
              Connect your OpenWork account
            </button>{" "}
            to use your organization's models.
          </>
        ) : null}
      </p>
    </div>
  );
}
