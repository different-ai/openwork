import { useId, useState } from "react";
import { coworkerBridge, type CoworkerSummary, type ProviderSyncRun, type RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { workerTurnsFor } from "@/lib/effort";
import { clearAutoPicked } from "@/lib/model-choice";
import { usesAppConversationDefault } from "@/lib/model-defaults";
import { normalizeModelSelectionPreferences, type ModelSelectionPreferences } from "@/lib/model-intelligence-index";
import type { EngineModelCatalog } from "@/lib/threads";
import { EffortDial } from "@/ui/effort-dial";
import { Button, ErrorNote, Field, inputClass } from "@/ui/kit";
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
      <p className="text-[11px] leading-relaxed text-mist">Used for automatic model choices, including the app's Automatic default. Saving does not change your model, selection mode or effort. Preferences never override provider, price or capability safety checks.</p>
      <Field label="Automatic priority">
        <select aria-label="Automatic priority" className={`${inputClass} bg-panel`} value={priority} disabled={saving} onChange={(event) => setPriority(normalizeModelSelectionPreferences({ priority: event.target.value }).priority)}>
          <option value="balanced">Balanced</option>
          <option value="cost">Lower token cost</option>
          <option value="capability">More documented capacity</option>
        </select>
      </Field>
      <p className="text-[11px] leading-relaxed text-mist">One exact provider/model ID per line, up to 8 per list. Preferred lists are ordered first to last. Use Inspect model facts in a model picker to browse connected IDs without changing your model.</p>
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
  const pickerProps = { runtime, session, coworker, onSyncProviders, onConnect: onOpenAccount, compact: true, catalog, catalogLoading, onRefreshCatalog };
  const preferences = normalizeModelSelectionPreferences(coworker.modelSelectionPreferences);
  const inheritsConversation = usesAppConversationDefault(coworker);
  return (
    <fieldset disabled={saving} aria-busy={saving} className="min-w-0 space-y-6 disabled:opacity-70">
      <section data-testid="coworker-model-settings">
        <h3 className="text-xs font-semibold text-snow">Main model</h3>
        <p className="mb-3 mt-1 text-xs leading-relaxed text-mist" data-testid="coworker-model-note">
          Choose whether {coworker.name}'s conversations follow the app default or a personal model. Switching to the app default keeps the saved personal model and assignment settings.
        </p>
        <div className="mb-3 space-y-2 rounded-xl border border-line bg-panel p-3" role="radiogroup" aria-label="Conversation model source">
          <label className="flex items-start gap-2 text-xs leading-relaxed text-snow">
            <input className="mt-0.5 shrink-0" type="radio" name={inheritanceId} checked={inheritsConversation} onChange={() => void update({ useAppModelDefaults: true })} />
            <span>Use app conversation default</span>
          </label>
          <label className="flex items-start gap-2 text-xs leading-relaxed text-snow">
            <input className="mt-0.5 shrink-0" type="radio" name={inheritanceId} checked={!inheritsConversation} onChange={() => void update({ useAppModelDefaults: false })} />
            <span>Customize for this coworker</span>
          </label>
        </div>
        <p className="mb-3 text-[11px] leading-relaxed text-mist">
          {onOpenModelDefaults ? <button type="button" className="font-medium text-spark hover:underline" onClick={onOpenModelDefaults}>Change app model defaults</button> : "Change shared choices in Settings > Model defaults."}
        </p>
        {inheritsConversation ? (
          <p className="break-words text-xs leading-relaxed text-mist">Conversations use the app default, including its thinking effort. {coworker.model ? `Saved personal model: ${coworker.model}. Choose Customize to use it again.` : "No personal model is saved yet. Choose Customize to pick one."}</p>
        ) : <ModelPicker {...pickerProps} value={coworker.model} modelVariant={coworker.modelVariant} chosenBy={coworker.modelChosenBy} modelMode={coworker.modelMode} onChange={(selection) => void update({ ...selection, modelChosenBy: "person", useAppModelDefaults: false })} />}
        <details className="mt-4 text-xs text-mist" data-testid="model-selection-preferences">
          <summary className="cursor-pointer font-medium text-snow">Automatic preferences: {preferences.priority === "cost" ? "Lower token cost" : preferences.priority === "capability" ? "More documented capacity" : "Balanced"}</summary>
          <ModelPreferences key={`${coworker.slug}:${JSON.stringify(preferences)}`} preferences={preferences} saving={saving} onSave={(modelSelectionPreferences) => void update({ modelSelectionPreferences })} />
        </details>
        <div className="mt-5" data-testid="coworker-effort-settings">
          {inheritsConversation ? <p className="mb-2 text-[11px] leading-relaxed text-mist">When app effort is Automatic, this preference still applies. A fixed app effort takes priority for conversations. Your personal exact effort is kept for assignments.</p> : null}
          <EffortDial stop={coworker.effortPreference} onChange={(effortPreference) => void update({ effortPreference })} coworkerName={coworker.name} fixedVariant={coworker.modelVariant} compact={false} />
        </div>
      </section>
      <section className="space-y-5 border-t border-line pt-4" data-testid="coworker-worker-model-settings">
        <div>
          <h3 className="text-xs font-semibold text-snow">Worker defaults</h3>
          <p className="mt-1 text-xs leading-relaxed text-mist">Workers do delegated tasks for {coworker.name}. An explicit choice here overrides the app default for that purpose. Leave it empty to use the app default, then role-appropriate Automatic. Existing Workers are unchanged.</p>
        </div>
        <div data-testid="thinking-model-settings">
          <h4 className="text-xs font-medium text-snow">Deep thinking model</h4>
          <p className="mb-3 mt-1 text-xs leading-relaxed text-mist">Used when {coworker.name} needs help with an unclear decision before doing the work. Choose a stronger reasoning model for difficult trade-offs, or keep the app default.</p>
          <ModelPicker {...pickerProps} value={coworker.thinkingModel ?? ""} modelVariant={coworker.thinkingModelVariant ?? ""} onChange={(selection) => void updateWorker("thinking", selection)} forWorker />
          <p className="mt-2 text-[11px] leading-relaxed text-mist">Produces a short decision brief. Two turns by default.</p>
        </div>
        <div data-testid="delivery-model-settings">
          <h4 className="text-xs font-medium text-snow">Delivery model</h4>
          <p className="mb-3 mt-1 text-xs leading-relaxed text-mist">Used to carry out a delegated task and return the result to {coworker.name}. Customize it for the capabilities and known token costs that task needs.</p>
          <ModelPicker {...pickerProps} value={coworker.deliveryModel ?? ""} modelVariant={coworker.deliveryModelVariant ?? ""} onChange={(selection) => void updateWorker("delivery", selection)} forWorker />
          <p className="mt-2 text-[11px] leading-relaxed text-mist">Up to {workerTurnsFor(coworker.effortPreference)} turns by default, based on the effort setting above.</p>
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
