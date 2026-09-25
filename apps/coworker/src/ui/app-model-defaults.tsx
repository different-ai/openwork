import { useEffect, useState } from "react";
import { coworkerBridge, type RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { DEFAULT_MODEL_DEFAULTS, type ModelDefault, type ModelDefaults, type ModelPurpose } from "@/lib/model-defaults";
import type { EngineModelCatalog } from "@/lib/threads";
import { resolveModelPreview, type ModelChoicePreview } from "@/lib/model-choice";
import { InlineLoader } from "@/ui/brand";
import { Button, ErrorNote, HelpTip } from "@/ui/kit";
import { ModelPicker } from "@/ui/model-picker";

const PURPOSES: { id: ModelPurpose; title: string; description: string; help: string }[] = [
  { id: "conversation", title: "Conversation model", description: "For everyday messages.", help: "Answers messages directly. Longer work can go to a helper." },
  { id: "thinking", title: "Deep thinking model", description: "For difficult decisions.", help: "A helper weighs a difficult decision and returns a short brief before work starts." },
  { id: "delivery", title: "Task model", description: "For longer work.", help: "A helper uses available tools to carry out a task and bring the result back." },
  { id: "facilitator", title: "Group chat guide", description: "Chooses who answers next.", help: "A quiet guide chooses the next speaker in a group chat. It does not send messages of its own." },
];

function ModelDefaultRows({ runtime, session, defaults, catalog, catalogLoaded, catalogLoading, onRefreshCatalog, onChange, previewLoading = false }: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  defaults: ModelDefaults;
  catalog: EngineModelCatalog;
  catalogLoaded: boolean;
  catalogLoading: boolean;
  onRefreshCatalog: (options: { sync?: boolean }) => Promise<void>;
  onChange: (purpose: ModelPurpose, selection: ModelDefault) => void;
  previewLoading?: boolean;
}) {
  return PURPOSES.map(({ id, title, description, help }) => {
    const selection = defaults[id];
    const preview: ModelChoicePreview = catalogLoaded ? resolveModelPreview(catalog, id, defaults) : { state: "context", detail: "Model availability is unverified. Refresh the catalog to check this choice." };
    return (
      <section key={id} className="min-w-0 rounded-2xl border border-line bg-panel/45 p-4" aria-labelledby={`model-default-${id}`} data-testid={`model-default-${id}`}>
        <div className="flex items-center gap-2"><h2 id={`model-default-${id}`} className="text-sm font-semibold text-snow">{title}</h2><HelpTip label={title.toLowerCase()} content={help} /></div>
        <p className="mb-3 mt-1 text-xs text-mist">{description}</p>
        <ModelPicker runtime={runtime} session={session} catalog={catalog} catalogLoading={catalogLoading} onRefreshCatalog={onRefreshCatalog} defaultPurpose={id} value={selection.model} modelVariant={selection.modelVariant} compact onChange={(value) => onChange(id, value)} previewLoading={previewLoading} automaticPreview={preview} />
      </section>
    );
  });
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
