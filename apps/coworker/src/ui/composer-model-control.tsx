import { useEffect, useMemo, useRef, useState } from "react";
import type { HeadlessThreadModel } from "@openwork/headless-threads";

import { coworkerBridge, type CoworkerSummary, type RuntimeInfo } from "@/lib/bridge";
import {
  createCoworkerThreads,
  parseModelPreference,
  type EngineModelCatalog,
  type EngineModelOption,
} from "@/lib/threads";
import { Button, ErrorNote, StatusDot } from "@/ui/kit";

export type ThinkingEffort = "auto" | "quick" | "balanced" | "high" | "max";

export type TurnModelPreference = {
  /** Auto selects from Open Coworker's curated model preferences. */
  auto: boolean;
  /** The live resolved model. Empty means the OpenWork engine default. */
  model: string;
  modelVariant: string;
  effort: ThinkingEffort;
};

const EMPTY_CATALOG: EngineModelCatalog = { models: [], connectedProviderIds: [], cloud: null };

const EFFORTS: Array<{
  id: ThinkingEffort;
  label: string;
  description: string;
  variants: string[];
}> = [
  { id: "auto", label: "Auto", description: "Let the selected model balance speed and depth.", variants: [] },
  { id: "quick", label: "Quick", description: "For short answers and straightforward work.", variants: ["low", "minimal"] },
  { id: "balanced", label: "Standard", description: "A practical balance for everyday assignments.", variants: ["medium"] },
  { id: "high", label: "High", description: "More reasoning for difficult, multi-step work.", variants: ["high"] },
  { id: "max", label: "Max", description: "The deepest reasoning this model exposes.", variants: ["max", "ultra", "xhigh"] },
];

const CURATED_MODELS = [
  { match: "gpt-5.6-sol", label: "Deep work", description: "Preferred for complex planning, coding, and careful decisions." },
  { match: "claude-fable-5", label: "Everyday work", description: "Preferred for fast, polished writing and general work." },
  { match: "fable", label: "Everyday work", description: "A preferred fast model for general assignments." },
  { match: "gpt-5.6-terra", label: "Balanced work", description: "A preferred balance of speed and depth." },
  { match: "gpt-5.6-luna", label: "Quick work", description: "A preferred choice for simple, fast tasks." },
  { match: "gpt-5.5", label: "Complex work", description: "A strong fallback for demanding assignments." },
] as const;

function effortDefinition(effort: ThinkingEffort) {
  return EFFORTS.find((item) => item.id === effort) ?? EFFORTS[0]!;
}

function normalizedModelText(model: EngineModelOption): string {
  return `${model.id} ${model.modelId} ${model.modelLabel} ${model.family}`.toLowerCase();
}

function curatedDefinition(model: EngineModelOption) {
  const text = normalizedModelText(model);
  return CURATED_MODELS.find((item) => text.includes(item.match)) ?? null;
}

function preferenceScore(model: EngineModelOption, effort: ThinkingEffort): number {
  const text = normalizedModelText(model);
  let score = model.isProviderDefault ? 80 : 0;
  if (text.includes("gpt-5.6-sol")) {
    score += effort === "quick" ? 760 : effort === "balanced" ? 850 : 1_000;
  }
  else if (text.includes("claude-fable-5") || text.includes("fable")) {
    score += effort === "quick" || effort === "balanced" ? 1_000 : effort === "auto" ? 940 : 780;
  } else if (text.includes("gpt-5.6-terra")) score += effort === "balanced" ? 950 : 800;
  else if (text.includes("gpt-5.6-luna")) score += effort === "quick" ? 920 : 640;
  else if (text.includes("gpt-5.5")) score += 700;
  return score;
}

export function recommendedModel(models: EngineModelOption[], effort: ThinkingEffort): EngineModelOption | null {
  const supportsRequestedEffort = (model: EngineModelOption) =>
    effort === "auto" || effortDefinition(effort).variants.some((variant) => model.variants.includes(variant));
  const effortCapable = models.filter(supportsRequestedEffort);
  const candidates = effortCapable.length > 0 ? effortCapable : models;
  return [...candidates].sort((left, right) =>
    preferenceScore(right, effort) - preferenceScore(left, effort)
    || left.modelLabel.localeCompare(right.modelLabel),
  )[0] ?? null;
}

export function variantForEffort(model: EngineModelOption | null, effort: ThinkingEffort): string {
  if (!model || effort === "auto") return "";
  return effortDefinition(effort).variants.find((variant) => model.variants.includes(variant)) ?? "";
}

export function effortFromVariant(variant: string): ThinkingEffort {
  const normalized = variant.trim().toLowerCase();
  if (!normalized) return "auto";
  if (normalized === "minimal" || normalized === "low") return "quick";
  if (normalized === "medium") return "balanced";
  if (normalized === "high") return "high";
  if (normalized === "xhigh" || normalized === "max" || normalized === "ultra") return "max";
  return "auto";
}

export function initialTurnModelPreference(coworker: CoworkerSummary): TurnModelPreference {
  return {
    auto: !coworker.model,
    model: coworker.model,
    modelVariant: coworker.modelVariant,
    effort: effortFromVariant(coworker.modelVariant),
  };
}

export function threadModelForPreference(preference: TurnModelPreference): HeadlessThreadModel | undefined {
  const model = parseModelPreference(preference.model);
  if (!model) return undefined;
  return {
    ...model,
    ...(preference.modelVariant ? { variant: preference.modelVariant } : {}),
  };
}

function modelDescription(model: EngineModelOption): string {
  return curatedDefinition(model)?.description ?? `Available through ${model.providerLabel}.`;
}

function curatedModels(catalog: EngineModelCatalog, selectedId: string): EngineModelOption[] {
  const visible = catalog.models.filter((model) => curatedDefinition(model) || model.id === selectedId);
  return [...visible].sort((left, right) =>
    preferenceScore(right, "auto") - preferenceScore(left, "auto")
    || left.modelLabel.localeCompare(right.modelLabel),
  );
}

function supportedEfforts(model: EngineModelOption | null): ThinkingEffort[] {
  if (!model) return ["auto"];
  return EFFORTS
    .filter((effort) => effort.id === "auto" || effort.variants.some((variant) => model.variants.includes(variant)))
    .map((effort) => effort.id);
}

function automaticEfforts(catalog: EngineModelCatalog): ThinkingEffort[] {
  return EFFORTS
    .filter((effort) =>
      effort.id === "auto"
      || catalog.models.some((model) => effort.variants.some((variant) => model.variants.includes(variant))),
    )
    .map((effort) => effort.id);
}

export function ComposerModelControl({
  runtime,
  coworker,
  preference,
  running,
  onChange,
  onCoworkerChanged,
}: {
  runtime: RuntimeInfo;
  coworker: CoworkerSummary;
  preference: TurnModelPreference;
  running: boolean;
  onChange: (preference: TurnModelPreference) => void;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const threads = useMemo(
    () => coworker.workspaceId
      ? createCoworkerThreads({
          serverUrl: runtime.serverUrl,
          workspaceId: coworker.workspaceId,
          token: runtime.ownerToken,
        })
      : null,
    [coworker.workspaceId, runtime.ownerToken, runtime.serverUrl],
  );
  const [catalog, setCatalog] = useState<EngineModelCatalog>(EMPTY_CATALOG);
  const [open, setOpen] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!threads || !runtime.engineManaged) return;
    let cancelled = false;
    setLoading(true);
    void threads.listModelCatalog()
      .then((next) => {
        if (!cancelled) {
          setCatalog(next);
          setError("");
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [runtime.engineManaged, threads]);

  const selected = catalog.models.find((model) => model.id === preference.model) ?? null;
  const automatic = recommendedModel(catalog.models, preference.effort);
  const resolvedAutomaticVariant = variantForEffort(automatic, preference.effort);

  useEffect(() => {
    if (!preference.auto || !automatic) return;
    if (preference.model === automatic.id && preference.modelVariant === resolvedAutomaticVariant) return;
    onChange({ ...preference, model: automatic.id, modelVariant: resolvedAutomaticVariant });
  }, [automatic, onChange, preference, resolvedAutomaticVariant]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target instanceof Node ? event.target : null)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  const activeModel = preference.auto ? automatic : selected;
  const effort = effortDefinition(preference.effort);
  const availableEfforts = preference.auto ? automaticEfforts(catalog) : supportedEfforts(activeModel);
  const preferred = curatedModels(catalog, preference.model);

  function chooseEffort(nextEffort: ThinkingEffort) {
    const nextModel = preference.auto ? recommendedModel(catalog.models, nextEffort) : selected;
    onChange({
      ...preference,
      effort: nextEffort,
      model: nextModel?.id ?? preference.model,
      modelVariant: variantForEffort(nextModel, nextEffort),
    });
    setSaved(false);
  }

  function chooseModel(model: EngineModelOption | null) {
    const next = model ?? recommendedModel(catalog.models, preference.effort);
    onChange({
      ...preference,
      auto: model === null,
      model: next?.id ?? "",
      modelVariant: variantForEffort(next, preference.effort),
    });
    setShowModels(false);
    setSaved(false);
  }

  async function saveDefault() {
    setSaving(true);
    setError("");
    try {
      const updated = await coworkerBridge.coworkers.update(coworker.slug, {
        model: preference.auto ? "" : preference.model,
        modelVariant: preference.modelVariant,
      });
      onCoworkerChanged(updated);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={rootRef} className="relative" data-testid="composer-model-control">
      <button
        type="button"
        className="flex h-8 items-center gap-1.5 rounded-full border border-transparent bg-white/5 px-3 text-[11px] font-medium text-mist transition-colors hover:border-white/8 hover:bg-white/8 hover:text-snow"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        <span>Thinking effort</span>
        <span className="text-snow">· {effort.label}</span>
        <span aria-hidden="true">⌄</span>
      </button>

      {open ? (
        <div
          className="absolute bottom-full left-0 z-40 mb-2 w-[360px] overflow-hidden rounded-[22px] border border-line bg-[#0d121b] text-left"
          role="dialog"
          aria-label="Model and thinking effort"
          data-testid="composer-model-popover"
        >
          <div className="border-b border-line px-4 py-3.5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Thinking effort</p>
                <p className="mt-1 text-base font-semibold text-snow">{effort.label}</p>
              </div>
              {running ? <span className="rounded-full bg-white/5 px-2 py-1 text-[9px] text-mist">Next message</span> : null}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-mist">{effort.description}</p>

            <div className="relative mt-4 flex items-start justify-between">
              <div className="absolute left-3 right-3 top-2 h-px bg-line" />
              {EFFORTS.filter((item) => availableEfforts.includes(item.id)).map((item) => {
                const active = item.id === preference.effort;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="relative z-10 flex min-w-12 flex-col items-center gap-1.5 text-[9px] text-mist hover:text-snow"
                    aria-label={`${item.label} thinking effort`}
                    aria-pressed={active}
                    onClick={() => chooseEffort(item.id)}
                  >
                    <span className={`block size-4 rounded-full border transition-colors ${active ? "border-spark bg-spark" : "border-line bg-[#0d121b]"}`} />
                    <span className={active ? "text-snow" : ""}>{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="px-4 py-3.5">
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-xl px-1 py-1 text-left"
              onClick={() => setShowModels((current) => !current)}
            >
              <span className="flex size-8 items-center justify-center rounded-lg border border-line bg-panel">
                <StatusDot tone={activeModel ? "mint" : "mist"} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[10px] font-medium text-mist">{preference.auto ? "Auto-selected model" : "Selected model"}</span>
                <span className="mt-0.5 block truncate text-xs font-semibold text-snow">
                  {activeModel?.modelLabel ?? (loading ? "Choosing…" : "OpenWork default")}
                </span>
              </span>
              <span className="text-[10px] text-spark">{showModels ? "Done" : "Change"}</span>
            </button>

            {showModels ? (
              <div className="mt-3 overflow-hidden rounded-xl border border-line bg-ink">
                <button
                  type="button"
                  className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left ${preference.auto ? "bg-white/7" : "hover:bg-white/4"}`}
                  onClick={() => chooseModel(null)}
                >
                  <span className="mt-0.5 text-xs text-spark">{preference.auto ? "✓" : "○"}</span>
                  <span>
                    <span className="block text-xs font-semibold text-snow">Auto · Recommended</span>
                    <span className="mt-0.5 block text-[10px] leading-relaxed text-mist">Uses the best preferred model available for this effort.</span>
                  </span>
                </button>
                {preferred.map((model) => (
                  <button
                    type="button"
                    key={model.id}
                    className={`flex w-full items-start gap-2.5 border-t border-line px-3 py-2.5 text-left ${!preference.auto && model.id === preference.model ? "bg-white/7" : "hover:bg-white/4"}`}
                    onClick={() => chooseModel(model)}
                  >
                    <span className="mt-0.5 text-xs text-spark">{!preference.auto && model.id === preference.model ? "✓" : "○"}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-semibold text-snow">{model.modelLabel}</span>
                      <span className="mt-0.5 block text-[10px] leading-relaxed text-mist">{modelDescription(model)}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}

            <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3">
              <p className="text-[9px] leading-relaxed text-mist">
                {saved ? `Saved for ${coworker.name}` : `This choice applies to ${running ? "the next message" : "this conversation"}.`}
              </p>
              <Button variant="ghost" className="shrink-0 px-2 text-[10px]" disabled={saving} onClick={() => void saveDefault()}>
                {saving ? "Saving…" : saved ? "Saved" : "Make default"}
              </Button>
            </div>
            {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
