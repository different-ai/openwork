import { useCallback, useEffect, useRef, useState } from "react";
import { coworkerBridge, type ProviderSyncRun, type RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { DEFAULT_MODEL_DEFAULTS, type ModelDefault, type ModelDefaults, type ModelPurpose } from "@/lib/model-defaults";
import { createCoworkerThreads, runtimeWorkspaceReadinessKey, type EngineModelCatalog } from "@/lib/threads";
import { resolveModelPreview, type ModelChoicePreview } from "@/lib/model-choice";
import { chooseOnboardingModel, onboardingModelReview, type OnboardingDraft } from "@/lib/onboarding-team";
import { CoworkerMark, InlineLoader } from "@/ui/brand";
import { Button, ChevronIcon, ErrorNote, HelpTip } from "@/ui/kit";
import { ModelPicker } from "@/ui/model-picker";

const PURPOSES: { id: ModelPurpose; title: string; description: string; help: string }[] = [
  { id: "conversation", title: "Conversation model", description: "For everyday messages.", help: "Answers messages directly. Longer work can go to a helper." },
  { id: "thinking", title: "Deep thinking model", description: "For difficult decisions.", help: "A helper weighs a difficult decision and returns a short brief before work starts." },
  { id: "delivery", title: "Task model", description: "For longer work.", help: "A helper uses available tools to carry out a task and bring the result back." },
  { id: "facilitator", title: "Group chat guide", description: "Chooses who answers next.", help: "A quiet guide chooses the next speaker in a group chat. It does not send messages of its own." },
];

const EMPTY_CATALOG: EngineModelCatalog = { models: [], connectedProviderIds: [], cloud: null };
const PENDING_CATALOG_READ_LIMIT = 5;
const PENDING_CATALOG_RECHECK_MS = 2_000;
const PENDING_CATALOG_READ_TIMEOUT_MS = 10_000;

export function ModelDefaultRows({ runtime, session, defaults, catalog, catalogLoaded, catalogLoading, onRefreshCatalog, onChange, previews, previewLoading = false, compact = false }: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  defaults: ModelDefaults;
  catalog: EngineModelCatalog;
  catalogLoaded: boolean;
  catalogLoading: boolean;
  onRefreshCatalog: (options: { sync?: boolean }) => Promise<void>;
  onChange: (purpose: ModelPurpose, selection: ModelDefault) => void;
  previews?: Record<ModelPurpose, ModelChoicePreview>;
  previewLoading?: boolean;
  compact?: boolean;
}) {
  return PURPOSES.map(({ id, title, description, help }) => {
    const selection = defaults[id];
    const preview: ModelChoicePreview = previews?.[id] ?? (catalogLoaded ? resolveModelPreview(catalog, id, defaults) : { state: "context", detail: "Model availability is unverified. Refresh the catalog to check this choice." });
    const picker = <ModelPicker runtime={runtime} session={session} catalog={catalog} catalogLoading={catalogLoading} onRefreshCatalog={onRefreshCatalog} defaultPurpose={id} value={selection.model} modelVariant={selection.modelVariant} compact onChange={(value) => onChange(id, value)} previewLoading={previewLoading} automaticPreview={preview} />;
    if (!compact) return (
      <section key={id} className="min-w-0 rounded-2xl border border-line bg-panel/45 p-4" aria-labelledby={`model-default-${id}`} data-testid={`model-default-${id}`}>
        <div className="flex items-center gap-2"><h2 id={`model-default-${id}`} className="text-sm font-semibold text-snow">{title}</h2><HelpTip label={title.toLowerCase()} content={help} /></div>
        <p className="mb-3 mt-1 text-xs text-mist">{description}</p>
        {picker}
      </section>
    );
    const model = catalog.models.find((option) => option.id === selection.model);
    const label = selection.model ? model?.modelLabel || "Saved model" : preview.state === "ready" ? `Automatic: ${preview.model.modelLabel}` : "Automatic";
    const effort = selection.modelVariant || (preview.state === "ready" ? preview.variant : "");
    return (
      <details key={id} className="group/model-row min-w-0 border-b border-line" data-testid={`model-default-${id}`}>
        <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 rounded-lg py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50 [&::-webkit-details-marker]:hidden">
          <span className="shrink-0 font-medium text-snow" title={help}>{title}</span>
          <span className="min-w-0 flex-1 text-right text-xs text-mist">
            {previewLoading && !selection.model ? <span className="ml-auto block h-3 w-32 rounded bg-line" aria-label="Reading model choice" /> : <>
              <span className="block break-words text-snow">{label}</span>
              {effort ? <span className="break-words">{effort}</span> : null}
              {preview.state === "unavailable" ? <span className="ml-2 text-amber">Unavailable</span> : selection.model && preview.state === "context" ? <span className="ml-2">Unverified</span> : null}
            </>}
          </span>
          <ChevronIcon direction="right" className="size-4 shrink-0 text-mist transition-transform duration-150 group-open/model-row:rotate-90 motion-reduce:transition-none" />
        </summary>
        <div className="min-w-0 pb-4">
          {picker}
          {preview.state === "unavailable" ? <p className="mt-2 break-words text-xs text-amber" role="status">{preview.detail} Refresh the catalog or edit this choice.</p> : null}
        </div>
      </details>
    );
  });
}

function onboardingCatalogScope(runtime: RuntimeInfo, session: DenSession | null, draft: Pick<OnboardingDraft, "contextKey" | "providerId">, workspaceId: string): string {
  return JSON.stringify([draft.contextKey, draft.providerId, session?.baseUrl, session?.orgId, session?.token, workspaceId, runtimeWorkspaceReadinessKey(runtime, workspaceId)]);
}

export function OnboardingModelDefaults({ runtime, session, draft, onChange, onContinue, onBack, onManageConnections, onSyncProviders, onRuntimeChanged }: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  draft: OnboardingDraft;
  onChange: (update: (current: OnboardingDraft) => OnboardingDraft) => void;
  onContinue: (defaults: ModelDefaults) => void;
  onBack: () => void;
  onManageConnections: () => void;
  onSyncProviders: () => Promise<ProviderSyncRun>;
  onRuntimeChanged: (runtime: RuntimeInfo, expected: RuntimeInfo, workspaceId: string, expectedSession: DenSession | null) => boolean;
}) {
  const [snapshot, setSnapshot] = useState<{ scope: string; workspaceId: string; defaults: ModelDefaults; catalog: EngineModelCatalog | null; checkedAt?: number } | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const pendingReads = useRef(0);
  const catalogRead = useRef<AbortController | null>(null);
  const scope = onboardingCatalogScope(runtime, session, draft, snapshot?.workspaceId ?? "");
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const runtimeSnapshotRef = useRef(runtime);
  runtimeSnapshotRef.current = runtime;
  const saveContext = JSON.stringify([draft.draftId, draft.contextKey, draft.providerId, session?.baseUrl, session?.orgId, session?.token]);
  const saveContextRef = useRef(saveContext);
  saveContextRef.current = saveContext;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const generation = useRef(0);
  const savingRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [readError, setReadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const current = snapshot?.scope === scope ? snapshot : null;
  const catalog = current?.catalog ?? EMPTY_CATALOG;
  const review = onboardingModelReview(draft, catalog, current?.defaults ?? DEFAULT_MODEL_DEFAULTS);
  const unresolved = PURPOSES.some(({ id }) => review.previews[id].state !== "ready"
    && !(id === "facilitator" && draft.modelChoices?.[id]?.model === "" && review.previews[id].state === "context"));
  const pending = catalog.cloud?.reloadPending === true;

  const refresh = useCallback(async (options: { sync?: boolean; observe?: boolean } = {}) => {
    if (!mounted.current) return;
    const knownPending = snapshotRef.current?.scope === scope && snapshotRef.current.catalog?.cloud?.reloadPending === true;
    const cached = options.observe && snapshotRef.current?.scope === scope ? snapshotRef.current : null;
    if (options.observe && (!cached?.catalog || !cached.workspaceId)) return;
    if (options.sync && !options.observe) pendingReads.current = 0;
    catalogRead.current?.abort();
    const controller = new AbortController();
    catalogRead.current = controller;
    const signal = options.observe ? AbortSignal.any([controller.signal, AbortSignal.timeout(PENDING_CATALOG_READ_TIMEOUT_MS)]) : undefined;
    const request = ++generation.current;
    const expected = runtimeSnapshotRef.current;
    const ownsRequest = () => mounted.current && !controller.signal.aborted && request === generation.current && scopeRef.current === scope;
    setLoading(true);
    setReadError("");
    let releaseAbort = () => {};
    try {
      if (options.sync && !options.observe && session) {
        const run = await onSyncProviders();
        if (!ownsRequest()) return;
        if (run.status === "failed") throw new Error(run.message || "OpenWork models could not be refreshed.");
      }
      const [workspace, settings]: [{ workspaceId: string }, { modelDefaults: ModelDefaults }] = cached
        ? [{ workspaceId: cached.workspaceId }, { modelDefaults: cached.defaults }]
        : await Promise.all([
          coworkerBridge.coordinator.ensure(),
          coworkerBridge.settings.get().then((settings) => {
            if (ownsRequest()) setSnapshot((previous) => ({ scope, workspaceId: previous?.workspaceId ?? "", defaults: settings.modelDefaults, catalog: previous?.scope === scope ? previous.catalog : null, checkedAt: previous?.scope === scope ? previous.checkedAt : undefined }));
            return settings;
          }),
        ]);
      if (!ownsRequest()) return;
      const read = async () => {
        signal?.throwIfAborted();
        const info = await coworkerBridge.runtimeInfo();
        signal?.throwIfAborted();
        if (!ownsRequest()) throw new Error("The model context changed.");
        if (!info.engineManaged || !workspace.workspaceId) throw new Error("The local AI service is unavailable. Retry, or manage your connections.");
        const models = await createCoworkerThreads({ serverUrl: info.serverUrl, token: info.ownerToken, workspaceId: workspace.workspaceId }).listModelCatalog(signal);
        signal?.throwIfAborted();
        return { info, models };
      };
      const aborted = signal ? new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        releaseAbort = () => signal.removeEventListener("abort", onAbort);
      }) : null;
      const { info, models } = await (aborted ? Promise.race([read(), aborted]) : read());
      if (!ownsRequest()) return;
      if ((options.observe || knownPending) && !models.cloud) throw new Error("Model update status is unverified. Refresh models to check again.");
      if (!onRuntimeChanged(info, expected, workspace.workspaceId, session)) throw new Error("The AI configuration changed. Refresh the catalog to read the current models.");
      const next = { scope: onboardingCatalogScope(info, session, draft, workspace.workspaceId), workspaceId: workspace.workspaceId, defaults: settings.modelDefaults, catalog: models, checkedAt: Date.now() };
      snapshotRef.current = next;
      setSnapshot(next);
      setLoading(false);
    } catch (cause) {
      if (ownsRequest()) setReadError(`Models could not be refreshed. Your choices are kept. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      releaseAbort();
      if (ownsRequest()) setLoading(false);
      if (catalogRead.current === controller) catalogRead.current = null;
    }
  }, [draft.contextKey, draft.providerId, onRuntimeChanged, onSyncProviders, scope, session]);

  useEffect(() => {
    if (!current?.catalog) void refresh();
    return () => { generation.current += 1; catalogRead.current?.abort(); };
  }, [refresh]);

  useEffect(() => {
    if (current?.catalog && !pending) { pendingReads.current = 0; return; }
    if (!pending || loading || saving || readError || pendingReads.current >= PENDING_CATALOG_READ_LIMIT) return;
    const timer = window.setTimeout(() => {
      pendingReads.current += 1;
      void refresh({ observe: true });
    }, PENDING_CATALOG_RECHECK_MS);
    return () => { window.clearTimeout(timer); };
  }, [current?.catalog, pending, loading, saving, readError, refresh]);

  async function continueWithModels() {
    if (!current?.catalog || loading || savingRef.current || readError || unresolved || pending) return;
    savingRef.current = true;
    const ownsSave = () => mounted.current && saveContextRef.current === saveContext;
    const defaults = review.defaults;
    onChange((latest) => ({ ...latest, modelChoices: defaults }));
    setSaving(true);
    setSaveError("");
    try {
      const settings = await coworkerBridge.settings.update({ modelDefaults: defaults });
      if (PURPOSES.some(({ id }) => settings.modelDefaults[id].model !== defaults[id].model || settings.modelDefaults[id].modelVariant !== defaults[id].modelVariant)) throw new Error("The saved choices did not match the reviewed models and efforts.");
      if (ownsSave()) onContinue(settings.modelDefaults);
    } catch (cause) {
      if (ownsSave()) setSaveError(`Model choices could not be confirmed. Your reviewed choices are kept; retry Continue. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <div className="window-shell window-drag flex h-full flex-col overflow-y-auto" data-testid="onboarding-models">
      <header className="window-controls-inset flex shrink-0 items-center px-6 pb-3 pt-5 md:px-8">
        <Button variant="ghost" className="window-no-drag text-xs" disabled={saving} onClick={onBack}>Back</Button>
      </header>
      <main className="window-no-drag flex flex-1 items-center justify-center px-6 py-8">
        <section className="w-full max-w-2xl">
          <div className="mb-5 flex items-center gap-3"><CoworkerMark size={44} /><h1 className="text-xl font-semibold tracking-tight text-snow">Choose your models</h1></div>
          <fieldset disabled={!current || saving} aria-busy={loading || saving} aria-label="Models for your team" className="min-w-0 disabled:opacity-70">
            <ModelDefaultRows runtime={runtime} session={session} catalog={catalog} catalogLoaded={Boolean(current?.catalog)} catalogLoading={loading} defaults={review.defaults} previews={current?.catalog ? review.previews : undefined} previewLoading={loading && !current?.catalog} onRefreshCatalog={refresh} onChange={(purpose, choice) => onChange((latest) => chooseOnboardingModel(latest, purpose, choice))} compact />
          </fieldset>
          <div className="mt-4 space-y-3">
            {readError ? <div role="alert"><ErrorNote>{readError}</ErrorNote></div> : null}
            {readError && current?.checkedAt ? <p className="text-xs text-mist">Last catalog read: {new Date(current.checkedAt).toLocaleString()}.</p> : null}
            {saveError ? <div role="alert"><ErrorNote>{saveError}</ErrorNote></div> : null}
            {current?.catalog && !loading && !catalog.models.length ? <p className="text-xs text-mist" role="status">No connected models are listed. Manage your connections, then refresh.</p> : null}
            {current && !loading && unresolved && catalog.models.length > 0 ? <p className="text-xs text-mist" role="status">Some model or effort choices are unavailable. Review the marked roles before continuing.</p> : null}
            {pending ? <p className="text-xs text-mist" role="status" data-testid="onboarding-models-pending" data-observation-state={readError || pendingReads.current >= PENDING_CATALOG_READ_LIMIT ? "paused" : "checking"}>{readError ? "Update status is unverified. Retry to check again." : pendingReads.current >= PENDING_CATALOG_READ_LIMIT ? "Model updates are still pending. Use Refresh models to check again." : "Models are still updating. Checking for completion."}</p> : null}
            <div className="flex items-center gap-2">
              <Button variant="ghost" className="text-xs" disabled={loading || saving} aria-busy={loading} onClick={() => void refresh({ sync: true })} data-testid="onboarding-models-refresh">{readError ? "Retry" : "Refresh models"}</Button>
              <Button variant="ghost" className="text-xs" disabled={saving} onClick={onManageConnections}>Manage connections</Button>
            </div>
          </div>
        </section>
      </main>
      <footer className="window-no-drag flex shrink-0 items-center justify-between gap-4 border-t border-line px-6 py-4 md:px-8">
        <span className="text-xs text-mist">Catalog availability only; paid access is unverified.</span>
        <Button variant="primary" disabled={!current?.catalog || loading || saving || Boolean(readError) || unresolved || pending} aria-busy={saving} onClick={() => void continueWithModels()} data-testid="onboarding-models-continue">Continue</Button>
      </footer>
    </div>
  );
}

export function AppModelDefaults({ active, runtime, session, catalog, catalogLoaded, catalogLoading, onRefreshCatalog, onOpenModels }: {
  active: boolean;
  runtime: RuntimeInfo;
  session: DenSession | null;
  catalog: EngineModelCatalog;
  catalogLoaded: boolean;
  catalogLoading: boolean;
  onRefreshCatalog: (options: { sync?: boolean }) => Promise<void>;
  onOpenModels: () => void;
}) {
  const [defaults, setDefaults] = useState<ModelDefaults | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setDefaults(null);
    setError("");
    setSaved(false);
    void coworkerBridge.settings.get().then((settings) => {
      if (!cancelled) setDefaults(settings.modelDefaults);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(`Could not read model defaults: ${cause instanceof Error ? cause.message : String(cause)}`);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [active, reload]);

  async function choose(purpose: ModelPurpose, selection: ModelDefault) {
    if (!defaults || saving) return;
    const next = { ...defaults, [purpose]: { model: selection.model, modelVariant: selection.modelVariant } };
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const settings = await coworkerBridge.settings.update({ modelDefaults: next });
      setDefaults(settings.modelDefaults);
      setSaved(true);
    } catch (cause) {
      setError(`Model defaults were not saved: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-w-0 space-y-4" data-testid="app-model-defaults">
      <p className="text-sm text-mist">Starting models for everyone. Personal choices still win.</p>
      {catalogLoading ? <InlineLoader label="Reading connected models" /> : !catalogLoaded || !catalog.models.length ? (
        <div className="rounded-xl border border-line bg-panel/45 p-3 text-xs leading-relaxed text-mist">
          {catalogLoaded ? "No connected models are listed yet." : "The model catalog is not ready. It needs a coworker workspace and the local AI service."} You can configure Automatic now and choose a specific model once the catalog is ready.
          <button type="button" className="mt-2 block font-medium text-spark hover:underline" onClick={onOpenModels}>Manage AI models</button>
        </div>
      ) : null}
      <div className="sticky top-0 z-10 space-y-2 rounded-xl border border-line bg-ink/95 p-3">
        <p className="text-xs text-mist" role="status">{loading ? "Reading model defaults..." : saving ? "Saving model defaults..." : saved ? "Model defaults saved." : defaults ? "Changes save automatically." : "Defaults cannot be edited until saved settings are read."}</p>
        {error ? <div role="alert"><ErrorNote>{error}</ErrorNote></div> : null}
        {!loading && !defaults ? <Button type="button" variant="ghost" onClick={() => setReload((value) => value + 1)}>Retry loading defaults</Button> : null}
      </div>
      <fieldset disabled={!active || !defaults || loading || saving} aria-busy={loading || saving} aria-label="Model defaults" className="min-w-0 space-y-3 disabled:opacity-70">
        <ModelDefaultRows runtime={runtime} session={session} defaults={defaults ?? DEFAULT_MODEL_DEFAULTS} catalog={catalog} catalogLoaded={Boolean(defaults) && catalogLoaded} catalogLoading={catalogLoading} onRefreshCatalog={onRefreshCatalog} onChange={(purpose, selection) => void choose(purpose, selection)} previewLoading={loading} />
      </fieldset>
      <details className="text-xs text-mist"><summary className="cursor-pointer">When do changes apply?</summary><p className="mt-1">New helpers use these choices. Existing helpers and scheduled assignments keep theirs.</p></details>
      <details className="text-xs leading-relaxed text-mist">
        <summary className="cursor-pointer font-medium text-snow">How Automatic chooses</summary>
        <p className="mt-2">Automatic applies role-specific rules to connected catalog facts: capabilities, supported effort and known token prices. It does not choose models or providers at random. Catalog facts are not measured speed or proof of paid access; missing facts stay unknown.</p>
        <p className="mt-2">Choose an explicit model to keep that choice, or inspect its catalog facts in the picker. An empty effort setting means Automatic for that role, not a fixed effort level.</p>
      </details>
    </div>
  );
}
