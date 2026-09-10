import { useCallback, useEffect, useMemo, useState } from "react";
import type { CoworkerSummary, ModelChosenBy, ProviderSyncRun, RuntimeInfo } from "@/lib/bridge";
import { describeSkippedProvider, type DenSession } from "@/lib/den";
import { carryVariant, describeModelPick, previewAutomaticChoice, type ModelMode } from "@/lib/model-choice";
import { effortForTurn, effortStopLabel } from "@/lib/effort";
import { chooseIndexedModel, MODEL_INTELLIGENCE_INDEX, type ModelSelectionPreferences } from "@/lib/model-intelligence";
import {
  createCoworkerThreads,
  modelSourceLabel,
  recommendModel,
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
  if (!value) return "Choose a connected model, or use the recommendation below.";
  if (!option) return "This saved model is not currently available from a connected provider.";
  return `${option.providerLabel} · ${option.modelId} · ${modelSourceLabel(option.source)}`;
}

/**
 * What Automatic would do right now, in one line: "Quick GPT-5 mini · Standard
 * GPT-5 · Deep GPT-5 pro". Falls back to the blurb until the catalog is read.
 */
export function describeAutomaticChoice(catalog: Pick<EngineModelCatalog, "models">, standard: string, preferences?: ModelSelectionPreferences): string {
  const preview = previewAutomaticChoice(catalog, standard, preferences);
  if (!preview.standard) return AUTOMATIC_BLURB;
  const parts = [
    `Quick ${preview.quick?.modelLabel ?? "Unavailable"}`,
    `Standard ${preview.standard.modelLabel}`,
    `Deep ${preview.deep?.modelLabel ?? "Unavailable"}`,
  ];
  return parts.join(" · ");
}

function ModelFacts({ model }: { model: EngineModelOption | undefined }) {
  const facts = model?.intelligence;
  const fact = (value: boolean | null | undefined) => value == null ? "Unknown" : value ? "Yes" : "No";
  const number = (value: number | null | undefined) => value == null ? "Unknown" : String(value);
  const service = MODEL_INTELLIGENCE_INDEX.services.find((entry) => entry.providerIds.includes(model?.providerId ?? ""));
  const adapter = MODEL_INTELLIGENCE_INDEX.adapters.find((entry) => entry.npm === facts?.adapterNpm);
  return (
    <div className="space-y-2 break-words text-[11px] leading-relaxed text-mist" data-testid="model-intelligence-facts">
      <p className="select-text font-mono text-snow">{model?.id ?? "No available model"}</p>
      <p>Source: {facts?.provenance ?? "Unknown"}. Status: {facts?.status ?? "Unknown"}.</p>
      <p>Tools: {fact(facts?.tools)}. Reasoning: {fact(facts?.reasoning)}.</p>
      <p>Input modalities: {facts ? Object.entries(facts.input).map(([key, value]) => `${key}: ${fact(value)}`).join("; ") : "Unknown"}.</p>
      <p>Output modalities: {facts ? Object.entries(facts.output).map(([key, value]) => `${key}: ${fact(value)}`).join("; ") : "Unknown"}.</p>
      <p>Token limits: input {number(facts?.limits.input)}; context {number(facts?.limits.context)}; output {number(facts?.limits.output)}.</p>
      <p>Catalog token prices per million tokens: input {number(facts?.cost.input)}; output {number(facts?.cost.output)}. Not an endpoint quote; missing prices are not free.</p>
      <p>SDK adapter: {facts?.adapterNpm ?? "Unknown"}. API model ID: {facts?.apiModelId ?? "Unknown"}.</p>
      <p>Registry service hint: {facts?.serviceFamily ?? "Unknown"} ({facts?.serviceEvidence ?? "Unknown"}). This is not authenticated service identity.</p>
      {adapter ? <p>{adapter.caveat}</p> : null}
      {service ? <p>{service.caveat}</p> : null}
      <p>Observed: {facts && Number.isFinite(facts.observedAt) && !Number.isNaN(new Date(facts.observedAt).getTime()) ? new Date(facts.observedAt).toLocaleString() : "Unknown"}. This is local observation time, not upstream freshness. Refresh in the model list re-reads available metadata.</p>
    </div>
  );
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
  forWorker = false,
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
  /** Worker choices are fixed snapshots, or inherit the coworker's standard model at creation. */
  forWorker?: boolean;
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
  const [inspectedId, setInspectedId] = useState("");

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

  const selected = catalog.models.find((option) => option.id === value && (!forWorker || (option.toolCall && option.status !== "deprecated")));
  const visible = catalog.models.filter((option) => {
    if (forWorker && (!option.toolCall || option.status === "deprecated")) return false;
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
  const recommended = recommendModel(catalog);
  const inherited = catalog.models.find((option) => option.id === coworker.model && option.toolCall && option.status !== "deprecated");
  const inheritedVariantUnavailable = Boolean(inherited && coworker.modelVariant && !inherited.variants.includes(coworker.modelVariant));
  const inheritedEffort = inherited ? effortForTurn({ kind: "worker-turn", stop: coworker.effortPreference, fixedVariant: coworker.modelVariant, variants: inherited.variants }) : "";
  const inheritedDescription = `${inherited?.modelLabel || coworker.model || "No main model selected"}${inheritedVariantUnavailable ? ` · Fixed effort ${coworker.modelVariant} unavailable` : inherited ? ` · ${inheritedEffort || "Model default"} effort` : ""}`;
  const cloudModelCount = catalog.models.filter((option) => option.source === "cloud").length;
  const skipped = catalog.cloud?.skippedProviders ?? [];
  const reloadPending = catalog.cloud?.reloadPending === true;
  const lastRunFailed = catalog.cloud?.lastRun?.status === "failed" ? catalog.cloud.lastRun : null;

  const automatic = modelMode === "auto";
  const automaticLine = automatic ? describeAutomaticChoice(catalog, value, coworker.modelSelectionPreferences) : "";
  const inspected = inspectedId ? catalog.models.find((model) => model.id === inspectedId) : forWorker && !value ? inherited : selected;

  /** Change the main model without changing the person's fixed or Automatic policy. */
  function selectModel(model: EngineModelOption | null) {
    onChange({
      model: model?.id ?? "",
      modelVariant: carryVariant(modelVariant, model),
      modelMode: forWorker ? "fixed" : modelMode,
    });
    if (compact) setOpen(false);
  }

  return (
    <div className="space-y-3" data-testid="model-picker" data-model-mode={modelMode}>
      {!forWorker ? (
        <Field label="Model selection">
          <select className={`${inputClass} bg-panel`} value={modelMode} onChange={(event) => onChange({ model: value, modelVariant, modelMode: event.target.value === "auto" ? "auto" : "fixed" })}>
            <option value="fixed">Use the selected model</option>
            <option value="auto">Automatic for each message</option>
          </select>
          <p className="mt-1 text-[11px] leading-relaxed text-mist">{automatic ? "Chooses models from the same provider for quick questions or deeper work. Select the main model below." : "Keeps the same model. Choose Automatic if you want the app to select a model for each message."}</p>
        </Field>
      ) : null}
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-xl border border-line bg-panel px-3 py-3 text-left transition-colors hover:border-white/20 hover:bg-white/5"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-ink">
          <StatusDot tone={forWorker && !value ? inherited && !inheritedVariantUnavailable ? "mint" : "amber" : selected ? "mint" : "amber"} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-snow" data-testid="model-picker-current">
            {forWorker && !value ? `Use ${coworker.name}'s main model` : selected?.modelLabel || value || "Choose a model"}
          </span>
          <span className="mt-0.5 block break-words text-[11px] leading-relaxed text-mist" data-testid="model-picker-current-detail">
            {forWorker && !value ? inheritedDescription : selectedDescription(selected, value)}
          </span>
        </span>
        <span className="text-xs text-mist" aria-hidden="true">{open ? "⌃" : "⌄"}</span>
      </button>
      {automatic ? (
        <details className="text-[11px] leading-relaxed text-mist" data-testid="model-option-automatic-preview">
          <summary className="cursor-pointer">{automaticLine} <span className="text-snow">Why these models?</span></summary>
          <div className="mt-2 space-y-3" data-testid="model-automatic-reasons">
            {(["quick", "standard", "deep"] as const).map((lane) => {
              const decision = chooseIndexedModel(catalog, lane, { standard: value, preferences: coworker.modelSelectionPreferences });
              return (
                <div key={lane} className="space-y-1 border-l border-line pl-3">
                  <p className="font-medium capitalize text-snow">{lane}: {decision.model?.modelLabel ?? "Unavailable"}</p>
                  <p>{decision.reason}</p>
                  <details>
                    <summary className="cursor-pointer">Catalog facts for this choice</summary>
                    <ModelFacts model={decision.model ?? undefined} />
                  </details>
                </div>
              );
            })}
          </div>
        </details>
      ) : null}
      <details className="text-[11px] leading-relaxed text-mist" data-testid="model-intelligence-details">
        <summary className="cursor-pointer font-medium">Inspect model facts</summary>
        <div className="mt-2 space-y-3">
          <select aria-label="Inspect connected model" className={`${inputClass} bg-panel text-xs`} value={inspectedId} onChange={(event) => setInspectedId(event.target.value)}>
            <option value="">Selected model</option>
            {catalog.models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
            {inspectedId && !inspected ? <option value={inspectedId}>{inspectedId} (unavailable)</option> : null}
          </select>
          <p>Inspection does not change your model. Only the connected catalog supplies choices; registry entries are non-exhaustive documentation, not authorization.</p>
          <ModelFacts model={inspected} />
          <details>
            <summary className="cursor-pointer">Selection policy {MODEL_INTELLIGENCE_INDEX.version} / reviewed {MODEL_INTELLIGENCE_INDEX.reviewedAt}</summary>
            <div className="mt-2 space-y-2">
              {Object.entries(MODEL_INTELLIGENCE_INDEX.tasks).map(([lane, policy]) => (
                <p key={lane}><span className="font-medium capitalize text-snow">{lane}: </span>{policy.purpose} {policy.guard}</p>
              ))}
              {MODEL_INTELLIGENCE_INDEX.caveats.map((caveat) => <p key={caveat}>{caveat}</p>)}
              <p>Policy sources: {Object.keys(MODEL_INTELLIGENCE_INDEX.sources).map((name) => name.replace(/([A-Z])/g, " $1")).join(", ")}. Review date describes this policy, not live catalog freshness.</p>
            </div>
          </details>
        </div>
      </details>
      {forWorker && !value ? <p className="text-[11px] leading-relaxed text-mist">Copies the main model and its effort setting when this Worker starts.</p> : null}
      {forWorker && !value && inheritedVariantUnavailable ? <ErrorNote>New Workers cannot start with this effort. Choose a supported effort for the main model, or select a different Worker model.</ErrorNote> : null}
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
              className={`mt-1 flex w-full items-start gap-2 rounded-xl px-2.5 py-2.5 text-left ${!automatic && !value ? "bg-white/8" : "hover:bg-white/5"}`}
              disabled={!forWorker && !recommended}
              onClick={() => selectModel(forWorker ? null : recommended ?? null)}
            >
              <StatusDot tone={!automatic && !value ? "mint" : "mist"} />
              <span>
                <span className="block text-xs font-semibold text-snow">{forWorker ? `Use ${coworker.name}'s main model` : "Use recommended model"}</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-mist">{forWorker ? inheritedDescription : recommended ? `Select ${recommended.modelLabel} from your connected models. You can change it any time.` : "No connected model can use tools yet."}</span>
              </span>
            </button>

            {value && !selected ? (
              <div className="mt-1 rounded-xl bg-amber/8 px-2.5 py-2 text-[11px] leading-relaxed text-amber" data-testid="model-unavailable">
                Saved selection {value} is unavailable. {forWorker ? "New Workers will be blocked until you choose an available model." : "Choose a connected model or use the recommendation."}
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
                    className={`flex w-full items-start gap-2 rounded-xl px-2.5 py-2 text-left ${option.id === value ? "bg-white/8" : "hover:bg-white/5"}`}
                    onClick={() => selectModel(option)}
                  >
                    <StatusDot tone={option.id === value ? "mint" : "mist"} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-medium text-snow">{option.modelLabel}</span>
                        {option.isProviderDefault ? (
                          <span className="shrink-0 rounded-full bg-white/7 px-1.5 py-0.5 text-[8px] text-mist">Provider default</span>
                        ) : null}
                        {automatic && option.id === value ? (
                          <span className="shrink-0 rounded-full bg-spark/14 px-1.5 py-0.5 text-[8px] uppercase tracking-wide text-[#b8caff]" data-testid="model-standard-tag">Standard</span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block break-all text-[10px] text-mist">{option.id}</span>
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
        <Field label={automatic ? "Main model effort" : "Thinking effort"}>
          <select
            className={`${inputClass} bg-panel`}
            value={modelVariant}
            title={forWorker ? "The Worker keeps this effort from its first turn." : "Follow the effort setting below, or choose a fixed level."}
            onChange={(event) => onChange({ model: value, modelVariant: event.target.value, modelMode })}
          >
            <option value="">Follow effort setting · {effortStopLabel(coworker.effortPreference)}</option>
            {variants.map((variant) => (
              <option key={variant} value={variant}>{variant.slice(0, 1).toUpperCase() + variant.slice(1)}</option>
            ))}
          </select>
          <p className="mt-1 text-[11px] leading-relaxed text-mist">{forWorker ? "Sets effort once when the Worker starts. A fixed level overrides the effort setting above." : "Leave this on Follow effort setting to adapt to each task. A fixed level overrides that setting when supported."}</p>
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
      {open ? <p className="text-[11px] leading-relaxed text-mist" data-testid="model-picker-summary">
        {session
          ? cloudModelCount > 0
            ? `${cloudModelCount} model${cloudModelCount === 1 ? "" : "s"} from your OpenWork account. Other models are configured on this Mac.`
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
      </p> : null}
    </div>
  );
}
