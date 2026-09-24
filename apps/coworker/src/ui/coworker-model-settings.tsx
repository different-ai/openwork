import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary, type ProviderSyncRun, type RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { workerTurnsFor } from "@/lib/effort";
import { clearAutoPicked, describeModelPreview, resolveModelPreview, type ModelChoicePreview } from "@/lib/model-choice";
import { usesAppConversationDefault, type ModelDefaults, type ModelPurpose } from "@/lib/model-defaults";
import { normalizeModelSelectionPreferences, type ModelSelectionPreferences } from "@/lib/model-intelligence-index";
import { createCoworkerThreads, type EngineModelCatalog } from "@/lib/threads";
import { EffortDial } from "@/ui/effort-dial";
import { Button, ErrorNote, Field, HelpTip, inputClass } from "@/ui/kit";
import { ModelPicker, type ModelSelection } from "@/ui/model-picker";

function ModelPreferences({ preferences, saving, onSave }: {
  preferences: ModelSelectionPreferences;
  saving: boolean;
  onSave: (preferences: ModelSelectionPreferences) => void;
}) {
  const [priority, setPriority] = useState(preferences.priority);
  const [draft, setDraft] = useState({ quick: preferences.preferred.quick.join("\n"), deep: preferences.preferred.deep.join("\n"), avoided: preferences.avoided.join("\n") });
  const lines = (text: string) => text.split("\n").map((id) => id.trim()).filter(Boolean);
  const input = { priority, preferred: { quick: lines(draft.quick), deep: lines(draft.deep) }, avoided: lines(draft.avoided) };
  const normalized = normalizeModelSelectionPreferences(input);
  const valid = JSON.stringify(input) === JSON.stringify(normalized);
  const changed = JSON.stringify(input) !== JSON.stringify(preferences);
  const fields: { key: keyof typeof draft; label: string }[] = [
    { key: "quick", label: "Preferred quick models" },
    { key: "deep", label: "Preferred deep models" },
    { key: "avoided", label: "Avoided models" },
  ];
  return (
    <div className="mt-3 space-y-3">
      <p className="text-[11px] leading-relaxed text-mist">Only affects choices marked Automatic.</p>
      <Field label="Automatic priority">
        <select aria-label="Automatic priority" className={`${inputClass} bg-panel`} value={priority} disabled={saving} onChange={(event) => setPriority(normalizeModelSelectionPreferences({ priority: event.target.value }).priority)}>
          <option value="balanced">Balanced</option>
          <option value="cost">Lower token cost</option>
          <option value="capability">More documented capacity</option>
        </select>
      </Field>
      <details className="text-[11px] leading-relaxed text-mist"><summary className="cursor-pointer">How to enter models</summary><p className="mt-1">Use one full provider/model ID per line, up to 8 in each list. Order preferred models from first choice to last. Find IDs in Inspect model facts. These choices never bypass provider, price, or capability checks.</p></details>
      {fields.map(({ key, label }) => (
        <Field key={key} label={label}>
          <textarea aria-label={label} className={`${inputClass} min-h-16 resize-y bg-panel font-mono text-xs`} rows={2} spellCheck={false} value={draft[key]} disabled={saving} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
        </Field>
      ))}
      {!valid ? <ErrorNote>Use at most 8 unique full provider/model IDs per list (up to 256 characters each), with no spaces or URLs.</ErrorNote> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={saving || !valid || !changed} onClick={() => onSave(normalized)}>Save preferences</Button>
        {changed ? <Button type="button" variant="ghost" disabled={saving} onClick={() => { setPriority(preferences.priority); setDraft({ quick: preferences.preferred.quick.join("\n"), deep: preferences.preferred.deep.join("\n"), avoided: preferences.avoided.join("\n") }); }}>Discard edits</Button> : null}
        <span className="text-[11px] text-mist" role="status">{changed ? "Unsaved preference edits" : "Preferences saved"}</span>
      </div>
    </div>
  );
}

/** Shared by app Settings and the coworker's sidebar. Both edit the same saved choices. */
export function CoworkerModelSettings({ runtime, session, coworker, onCoworkerChanged, onSyncProviders, onOpenAccount, onOpenModelDefaults, catalog, catalogLoading, onRefreshCatalog }: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  coworker: CoworkerSummary;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onSyncProviders: () => Promise<ProviderSyncRun>;
  onOpenAccount: () => void;
  onOpenModelDefaults?: () => void;
  catalog?: EngineModelCatalog;
  catalogLoading?: boolean;
  onRefreshCatalog?: (options: { sync?: boolean }) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const inheritanceId = useId();
  const [defaults, setDefaults] = useState<ModelDefaults | null>(null);
  const [localCatalog, setLocalCatalog] = useState<EngineModelCatalog>({ models: [], connectedProviderIds: [], cloud: null });
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState("");
  const previewGeneration = useRef(0);
  const threads = useMemo(() => !catalog && coworker.workspaceId && runtime.engineManaged
    ? createCoworkerThreads({ serverUrl: runtime.serverUrl, workspaceId: coworker.workspaceId, token: runtime.ownerToken }) : null,
  [catalog, coworker.workspaceId, runtime.engineManaged, runtime.ownerToken, runtime.serverUrl]);
  const refreshModelContext = useCallback(async (options: { sync?: boolean } = {}, refreshShared = true) => {
    const generation = ++previewGeneration.current;
    setPreviewLoading(true);
    setPreviewError("");
    try {
      if (!onRefreshCatalog && options.sync && session) await onSyncProviders();
      const [settings, nextCatalog] = await Promise.all([coworkerBridge.settings.get(), onRefreshCatalog ? refreshShared ? onRefreshCatalog(options) : undefined : threads?.listModelCatalog()]);
      if (generation !== previewGeneration.current) return;
      setDefaults(settings.modelDefaults);
      if (nextCatalog) setLocalCatalog(nextCatalog);
    } catch (cause) {
      if (generation === previewGeneration.current) setPreviewError(cause instanceof Error ? cause.message : "The current model choice could not be read.");
    } finally {
      if (generation === previewGeneration.current) setPreviewLoading(false);
    }
  }, [onRefreshCatalog, onSyncProviders, session, threads]);
  useEffect(() => {
    void refreshModelContext({}, false);
    return () => { previewGeneration.current += 1; };
  }, [refreshModelContext]);
  const modelCatalog = catalog ?? localCatalog;
  const preview = (purpose: ModelPurpose): ModelChoicePreview => previewError
    ? { state: "unavailable", detail: previewError }
    : defaults ? resolveModelPreview(modelCatalog, purpose, defaults, coworker)
      : { state: "context", detail: "The current app model defaults have not been loaded yet." };
  async function update(patch: Parameters<typeof coworkerBridge.coworkers.update>[1]) {
    if (saving) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const saved = await coworkerBridge.coworkers.update(coworker.slug, patch);
      if (patch.modelChosenBy === "person") clearAutoPicked(coworker.slug);
      onCoworkerChanged(saved);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }
  function updateWorker(purpose: "thinking" | "delivery", selection: ModelSelection) {
    return update(purpose === "thinking"
      ? { thinkingModel: selection.model, thinkingModelVariant: selection.modelVariant }
      : { deliveryModel: selection.model, deliveryModelVariant: selection.modelVariant });
  }
  const pickerProps = { runtime, session, coworker, onSyncProviders, onConnect: onOpenAccount, compact: true, catalog: modelCatalog, catalogLoading, previewLoading, onRefreshCatalog: refreshModelContext };
  const preferences = normalizeModelSelectionPreferences(coworker.modelSelectionPreferences);
  const inheritsConversation = usesAppConversationDefault(coworker);
  return (
    <fieldset disabled={saving} aria-busy={saving} className="min-w-0 space-y-6 disabled:opacity-70">
      <section data-testid="coworker-model-settings">
        <div className="flex items-center gap-2"><h3 className="text-sm font-semibold text-snow">My conversation model</h3><HelpTip label="conversation model" content={`The AI model ${coworker.name} uses to reply to you. You can use the shared choice or choose one just for ${coworker.name}. Switching back keeps the personal choice saved.`} /></div>
        <p className="mb-3 mt-1 text-xs text-mist" data-testid="coworker-model-note">How {coworker.name} answers your messages.</p>
        <div className="mb-3 space-y-2 rounded-xl border border-line bg-panel p-3" role="radiogroup" aria-label="Conversation model source">
          <label className="flex items-start gap-2 text-xs leading-relaxed text-snow">
            <input className="mt-0.5 shrink-0" type="radio" name={inheritanceId} checked={inheritsConversation} onChange={() => void update({ useAppModelDefaults: true })} />
            <span>Use the shared model</span>
          </label>
          <label className="flex items-start gap-2 text-xs leading-relaxed text-snow">
            <input className="mt-0.5 shrink-0" type="radio" name={inheritanceId} checked={!inheritsConversation} onChange={() => void update({ useAppModelDefaults: false })} />
            <span>Choose a model for {coworker.name}</span>
          </label>
        </div>
        <p className="mb-3 text-[11px] leading-relaxed text-mist">
          {onOpenModelDefaults ? <button type="button" className="font-medium text-spark hover:underline" onClick={onOpenModelDefaults}>Change shared models</button> : "Change shared models in Settings."}
        </p>
        {inheritsConversation ? (
          <div className="space-y-1 break-words text-xs leading-relaxed text-mist">
            <p className="font-semibold text-snow">{defaults && !defaults.conversation.model ? "Chosen automatically" : "Shared model"}</p>
            <p data-testid="coworker-automatic-current">{previewLoading || catalogLoading ? "Reading current model choice..." : describeModelPreview(preview("conversation"))}</p>
            {coworker.model ? <p>Personal choice saved: {modelCatalog?.models.find((model) => model.id === coworker.model)?.modelLabel ?? "currently unavailable"}</p> : null}
          </div>
        ) : <ModelPicker {...pickerProps} automaticPreview={preview("conversation")} value={coworker.model} modelVariant={coworker.modelVariant} chosenBy={coworker.modelChosenBy} modelMode={coworker.modelMode} onChange={(selection) => void update({ ...selection, modelChosenBy: "person", useAppModelDefaults: false })} />}
        <details className="mt-4 text-xs text-mist" data-testid="model-selection-preferences">
          <summary className="cursor-pointer font-medium text-snow">How Automatic chooses · {preferences.priority === "cost" ? "Lower cost" : preferences.priority === "capability" ? "More capable" : "Balanced"}</summary>
          <ModelPreferences key={`${coworker.slug}:${JSON.stringify(preferences)}`} preferences={preferences} saving={saving} onSave={(modelSelectionPreferences) => void update({ modelSelectionPreferences })} />
        </details>
        <div className="mt-5" data-testid="coworker-effort-settings">
          {inheritsConversation ? <details className="mb-2 text-[11px] leading-relaxed text-mist"><summary className="cursor-pointer">How this works with shared settings</summary><p className="mt-1">This preference applies when shared effort is Automatic. A fixed shared effort takes priority for conversations. Your personal exact effort remains saved for assignments.</p></details> : null}
          <EffortDial stop={coworker.effortPreference} onChange={(effortPreference) => void update({ effortPreference })} coworkerName={coworker.name} fixedVariant={coworker.modelVariant} compact={false} />
        </div>
      </section>
      <section className="space-y-5 border-t border-line pt-4" data-testid="coworker-worker-model-settings">
        <div>
          <div className="flex items-center gap-2"><h3 className="text-sm font-semibold text-snow">My helpers</h3><HelpTip label="helpers" content={`When ${coworker.name} asks another AI to help, these models handle that work. Choices here apply to new helpers; existing helpers keep their models.`} /></div>
          <p className="mt-1 text-xs text-mist">Choose who helps with difficult decisions and longer tasks.</p>
        </div>
        <div data-testid="thinking-model-settings">
          <div className="flex items-center gap-2"><h4 className="text-xs font-medium text-snow">My deep thinking model</h4><HelpTip label="deep thinking model" content={`Helps ${coworker.name} weigh a difficult decision before work begins. It returns a short decision brief.`} /></div>
          <p className="mb-3 mt-1 text-xs text-mist">For hard choices before work starts.</p>
          <ModelPicker {...pickerProps} automaticPreview={preview("thinking")} value={coworker.thinkingModel ?? ""} modelVariant={coworker.thinkingModelVariant ?? ""} onChange={(selection) => void updateWorker("thinking", selection)} forWorker />
        </div>
        <div data-testid="delivery-model-settings">
          <div className="flex items-center gap-2"><h4 className="text-xs font-medium text-snow">My task model</h4><HelpTip label="task model" content={`Carries out tasks ${coworker.name} delegates, then brings the result back. It gets up to ${workerTurnsFor(coworker.effortPreference)} turns by default at this effort setting.`} /></div>
          <p className="mb-3 mt-1 text-xs text-mist">For research, making things, and other longer work.</p>
          <ModelPicker {...pickerProps} automaticPreview={preview("delivery")} value={coworker.deliveryModel ?? ""} modelVariant={coworker.deliveryModelVariant ?? ""} onChange={(selection) => void updateWorker("delivery", selection)} forWorker />
        </div>
        <details className="text-[11px] leading-relaxed text-mist">
          <summary className="cursor-pointer font-medium">When do changes apply?</summary>
          <p className="mt-2">New Workers keep the model and effort they start with. If that model becomes unavailable, they stop instead of switching providers. Changing these defaults does not rewrite existing Worker selections or assignment settings.</p>
        </details>
      </section>
      <p className="text-[11px] text-mist" role="status">{saving ? "Saving..." : saved ? `Settings saved for ${coworker.name}.` : `Model and effort changes save automatically for ${coworker.name} only. Automatic preferences use Save preferences.`}</p>
      {error ? <div role="alert"><ErrorNote>{error}</ErrorNote></div> : null}
    </fieldset>
  );
}
