import { useState } from "react";
import { coworkerBridge, type CoworkerSummary, type ProviderSyncRun, type RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { workerTurnsFor } from "@/lib/effort";
import { clearAutoPicked } from "@/lib/model-choice";
import { EffortDial } from "@/ui/effort-dial";
import { ErrorNote } from "@/ui/kit";
import { ModelPicker, type ModelSelection } from "@/ui/model-picker";

/** Shared by app Settings and the coworker's sidebar. Both edit the same saved choices. */
export function CoworkerModelSettings({ runtime, session, coworker, onCoworkerChanged, onSyncProviders, onOpenAccount }: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  coworker: CoworkerSummary;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onSyncProviders: () => Promise<ProviderSyncRun>;
  onOpenAccount: () => void;
}) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function update(patch: Parameters<typeof coworkerBridge.coworkers.update>[1]) {
    setSaving(true);
    setError("");
    try {
      const saved = await coworkerBridge.coworkers.update(coworker.slug, patch);
      if (patch.modelChosenBy === "person") clearAutoPicked(coworker.slug);
      onCoworkerChanged(saved);
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
  const pickerProps = { runtime, session, coworker, onSyncProviders, onConnect: onOpenAccount, compact: true };
  return (
    <fieldset aria-busy={saving} className="min-w-0 space-y-6">
      <section data-testid="coworker-model-settings">
        <h3 className="text-xs font-semibold text-snow">Main model</h3>
        <p className="mb-3 mt-1 text-xs leading-relaxed text-mist" data-testid="coworker-model-note">
          {coworker.modelMode === "auto"
            ? `The starting model for ${coworker.name}. Automatic can choose another model for each discussion message. Assignments use this model.`
            : `The model ${coworker.name} uses for discussions and assignments. Choose one for the work you do most.`}
        </p>
        <ModelPicker {...pickerProps} value={coworker.model} modelVariant={coworker.modelVariant} chosenBy={coworker.modelChosenBy} modelMode={coworker.modelMode} onChange={(selection) => void update({ ...selection, modelChosenBy: "person" })} />
        <div className="mt-5" data-testid="coworker-effort-settings">
          <EffortDial stop={coworker.effortPreference} onChange={(effortPreference) => void update({ effortPreference })} coworkerName={coworker.name} fixedVariant={coworker.modelVariant} compact={false} />
        </div>
      </section>
      <section className="space-y-5 border-t border-line pt-4" data-testid="coworker-worker-model-settings">
        <div>
          <h3 className="text-xs font-semibold text-snow">Worker defaults</h3>
          <p className="mt-1 text-xs leading-relaxed text-mist">Workers do delegated tasks for {coworker.name}. These choices apply when a new Worker starts, not to your conversation.</p>
        </div>
        <div data-testid="thinking-model-settings">
          <h4 className="text-xs font-medium text-snow">Deep thinking model</h4>
          <p className="mb-3 mt-1 text-xs leading-relaxed text-mist">Used when {coworker.name} needs help with an unclear decision before doing the work. Choose a stronger reasoning model for difficult trade-offs, or keep the main model.</p>
          <ModelPicker {...pickerProps} value={coworker.thinkingModel ?? ""} modelVariant={coworker.thinkingModelVariant ?? ""} onChange={(selection) => void updateWorker("thinking", selection)} forWorker />
          <p className="mt-2 text-[11px] leading-relaxed text-mist">Produces a short decision brief. Two turns by default.</p>
        </div>
        <div data-testid="delivery-model-settings">
          <h4 className="text-xs font-medium text-snow">Delivery model</h4>
          <p className="mb-3 mt-1 text-xs leading-relaxed text-mist">Used to carry out a delegated task and return the result to {coworker.name}. Change it for the tools, speed or cost that task needs.</p>
          <ModelPicker {...pickerProps} value={coworker.deliveryModel ?? ""} modelVariant={coworker.deliveryModelVariant ?? ""} onChange={(selection) => void updateWorker("delivery", selection)} forWorker />
          <p className="mt-2 text-[11px] leading-relaxed text-mist">Up to {workerTurnsFor(coworker.effortPreference)} turns by default, based on the effort setting above.</p>
        </div>
        <details className="text-[11px] leading-relaxed text-mist">
          <summary className="cursor-pointer font-medium">When do changes apply?</summary>
          <p className="mt-2">New Workers keep the model and effort they start with. If that model becomes unavailable, they stop instead of switching providers. Older Workers without a saved model still follow {coworker.name}'s main model.</p>
        </details>
      </section>
      <p className="text-[11px] text-mist" role="status">{saving ? "Saving..." : `Changes save automatically for ${coworker.name} only.`}</p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </fieldset>
  );
}
