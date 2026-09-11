import { useCallback, useEffect, useMemo, useState } from "react";
import type { CoworkerSummary, ModelChosenBy, ProviderSyncRun, RuntimeInfo } from "@/lib/bridge";
import { describeSkippedProvider, type DenSession } from "@/lib/den";
import { carryVariant, describeModelPick, previewAutomaticChoice, type ModelMode } from "@/lib/model-choice";
import { effortStopLabel } from "@/lib/effort";
import type { ModelPurpose } from "@/lib/model-defaults";
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
      <p className="select-text font-mono text-snow">{model?.id ?? "No catalog model to inspect"}</p>
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
  defaultPurpose,
  catalog: sharedCatalog,
  catalogLoading = false,
  onRefreshCatalog,
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  coworker?: CoworkerSummary;
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
  /** Worker choices are fixed snapshots, or use the app's purpose default at creation. */
  forWorker?: boolean;
  /** App-wide role default, without a coworker or per-message selection policy. */
  defaultPurpose?: ModelPurpose;
  /** Share a parent's catalog rather than fetching once per picker. */
  catalog?: EngineModelCatalog;
  catalogLoading?: boolean;
  onRefreshCatalog?: (options: { sync?: boolean }) => Promise<void>;
}) {
  const threads = useMemo(
    () =>
      !sharedCatalog && coworker?.workspaceId
        ? createCoworkerThreads({
            serverUrl: runtime.serverUrl,
            workspaceId: coworker.workspaceId,
            token: runtime.ownerToken,
          })
        : null,
    [sharedCatalog, coworker?.workspaceId, runtime.ownerToken, runtime.serverUrl],
  );
  const [localCatalog, setCatalog] = useState<EngineModelCatalog>(EMPTY_CATALOG);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(!compact);
  const [localLoading, setLoading] = useState(false);
  const [syncNote, setSyncNote] = useState("");
  const [error, setError] = useState("");
  const [inspectedId, setInspectedId] = useState("");
  const catalog = sharedCatalog ?? localCatalog;
  const loading = localLoading || catalogLoading;

  const refresh = useCallback(async (options: { sync?: boolean } = {}) => {
    if (!onRefreshCatalog && (!threads || !runtime.engineManaged)) return;
    setLoading(true);
    setError("");
    try {
      if (onRefreshCatalog) {
        await onRefreshCatalog(options);
        return;
      }
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
      if (threads) setCatalog(await threads.listModelCatalog());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [onRefreshCatalog, onSyncProviders, runtime.engineManaged, session, threads]);

  useEffect(() => {
    if (!sharedCatalog) void refresh();
  }, [sharedCatalog, refresh]);

  const workerModel = forWorker || defaultPurpose === "thinking" || defaultPurpose === "delivery";
  const selected = catalog.models.find((option) => option.id === value && (!workerModel || (option.toolCall && option.status !== "deprecated")));
  const visible = catalog.models.filter((option) => {
    if (workerModel && (!option.toolCall || option.status === "deprecated")) return false;
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
  const variantUnavailable = Boolean(modelVariant && !variants.includes(modelVariant));
  const recommended = recommendModel(catalog);
  const allowsDefault = forWorker || Boolean(defaultPurpose);
  const defaultLabel = defaultPurpose ? "Automatic (role-appropriate)" : "Use app default";
  const defaultDescription = defaultPurpose
    ? "Chooses an eligible connected model for this role when needed."
    : "Uses the app default for this Worker's purpose, then role-appropriate Automatic.";
  const cloudModelCount = catalog.models.filter((option) => option.source === "cloud").length;
  const skipped = catalog.cloud?.skippedProviders ?? [];
  const reloadPending = catalog.cloud?.reloadPending === true;
  const lastRunFailed = catalog.cloud?.lastRun?.status === "failed" ? catalog.cloud.lastRun : null;

  const automatic = !allowsDefault && modelMode === "auto";
  const automaticLine = automatic ? describeAutomaticChoice(catalog, value, coworker?.modelSelectionPreferences) : "";
  const inspected = inspectedId ? catalog.models.find((model) => model.id === inspectedId) : selected;

  /** Change the main model without changing the person's fixed or Automatic policy. */
  function selectModel(model: EngineModelOption | null) {
    onChange({
      model: model?.id ?? "",
      modelVariant: model && model.id === value ? modelVariant : carryVariant(modelVariant, model),
      modelMode: allowsDefault ? "fixed" : modelMode,
    });
    if (compact) setOpen(false);
  }

  return (
    <div className="min-w-0 space-y-3" data-testid="model-picker" data-model-mode={modelMode}>
      {!allowsDefault ? (
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
          <StatusDot tone={allowsDefault && !value ? "mist" : selected ? "mint" : "amber"} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block break-words text-xs font-semibold text-snow" data-testid="model-picker-current">
            {allowsDefault && !value ? defaultLabel : selected?.modelLabel || value || "Choose a model"}
          </span>
          <span className="mt-0.5 block break-words text-[11px] leading-relaxed text-mist" data-testid="model-picker-current-detail">
            {allowsDefault && !value ? defaultDescription : selectedDescription(selected, value)}
          </span>
        </span>
        <span className="text-xs text-mist" aria-hidden="true">{open ? "⌃" : "⌄"}</span>
      </button>
      {automatic ? (
        <details className="text-[11px] leading-relaxed text-mist" data-testid="model-option-automatic-preview">
          <summary className="cursor-pointer">{automaticLine} <span className="text-snow">Why these models?</span></summary>
          <div className="mt-2 space-y-3" data-testid="model-automatic-reasons">
            {(["quick", "standard", "deep"] as const).map((lane) => {
              const decision = chooseIndexedModel(catalog, lane, { standard: value, preferences: coworker?.modelSelectionPreferences });
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
            <option value="">{value ? "Selected model" : "Choose a model to inspect"}</option>
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
      {forWorker && !value ? <p className="text-[11px] leading-relaxed text-mist">Resolves the app default when a new Worker starts, then keeps that model and effort.</p> : null}
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
              disabled={loading || (!threads && !onRefreshCatalog)}
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
              disabled={!allowsDefault && !recommended}
              onClick={() => selectModel(allowsDefault ? null : recommended ?? null)}
              aria-pressed={allowsDefault ? !value : Boolean(recommended && recommended.id === value)}
            >
              <StatusDot tone={!automatic && !value ? "mint" : "mist"} />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold text-snow">{allowsDefault ? defaultLabel : "Use recommended model"}</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-mist">{allowsDefault ? defaultDescription : recommended ? `Select ${recommended.modelLabel} from your connected models. You can change it any time.` : "No connected model can use tools yet."}</span>
              </span>
            </button>

            {value && !selected ? (
              <div className="mt-1 break-words rounded-xl bg-amber/8 px-2.5 py-2 text-[11px] leading-relaxed text-amber" data-testid="model-unavailable">
                Saved selection {value} is unavailable. {allowsDefault ? "Choose a connected model or return to the default. This explicit choice is not replaced automatically." : "Choose a connected model or use the recommendation."}
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
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="break-words text-xs font-medium text-snow">{option.modelLabel}</span>
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
                The connected model catalog is not available here yet. Refresh after a coworker workspace and provider are ready.{allowsDefault ? " You can still choose the default now." : ""}
              </p>
            ) : null}
            {!runtime.engineManaged ? (
              <p className="p-3 text-xs leading-relaxed text-rose">AI is unavailable, so models cannot be listed right now.</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {value && (defaultPurpose || variants.length > 0 || modelVariant) ? (
        <Field label={automatic ? "Main model effort" : "Thinking effort"}>
          <select
            className={`${inputClass} min-w-0 bg-panel`}
            value={modelVariant}
            title={defaultPurpose ? "Use automatic effort for this role, or choose a supported fixed level." : forWorker ? "The Worker keeps this effort from its first turn." : "Follow the effort setting below, or choose a fixed level."}
            onChange={(event) => onChange({ model: value, modelVariant: event.target.value, modelMode })}
          >
            <option value="">{defaultPurpose ? "Automatic effort for this role" : coworker ? `Follow effort setting · ${effortStopLabel(coworker.effortPreference)}` : "Model default effort"}</option>
            {variantUnavailable ? <option value={modelVariant} disabled>{modelVariant} (not currently offered)</option> : null}
            {variants.map((variant) => (
              <option key={variant} value={variant}>{variant.slice(0, 1).toUpperCase() + variant.slice(1)}</option>
            ))}
          </select>
          <p className="mt-1 text-[11px] leading-relaxed text-mist">{defaultPurpose
            ? variants.length ? "Automatic adapts effort to this role using the levels the model offers. A fixed level overrides it." : "No effort levels are listed for this model. Automatic uses its default when no levels are offered."
            : forWorker ? "Sets effort once when the Worker starts. A fixed level overrides the coworker's effort setting." : "Leave this on Follow effort setting to adapt to each task. A fixed level overrides that setting when supported."}</p>
          {variantUnavailable ? <p className="mt-1 break-words text-[11px] leading-relaxed text-amber" role="status">Saved effort "{modelVariant}" is not offered in the current catalog. It is still saved, not Automatic. Refresh the catalog or choose a supported effort.</p> : null}
        </Field>
      ) : null}

      {!value && modelVariant ? <p className="break-words text-[11px] leading-relaxed text-amber">Saved effort "{modelVariant}" is not used without an explicit model. Choose the default option again to clear it.</p> : null}

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
