import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { coworkerBridge, type CoworkerSummary, type ProviderSyncRun, type RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { effortStopLabel } from "@/lib/effort";
import { usesAppConversationDefault } from "@/lib/model-defaults";
import { acknowledgeCoworker, AvatarControls, CoworkerAvatar } from "@/ui/coworker-avatar";
import { CoworkerModelSettings, type ModelSettingsPart } from "@/ui/coworker-model-settings";
import { PersonalityPicker } from "@/ui/personality-picker";
import { Button, ChevronIcon, ErrorNote, Field, IconButton, inputClass } from "@/ui/kit";

export type CustomizeFocus = "model";

const MODEL_TABS: ReadonlyArray<{ id: ModelSettingsPart; title: string }> = [
  { id: "model", title: "AI model" },
  { id: "effort", title: "Thinking" },
  { id: "helpers", title: "Helpers" },
];

/**
 * Customizing a coworker, in a dialog over the conversation that fits
 * without scrolling. Up front is what most people change: its face (color
 * and glasses), its role and what it is here for, and its personality. The
 * AI model, how hard it thinks and its helpers wait behind one row, in tabs of
 * their own, and open directly when a reply needs a different model. The
 * profile saves with Save changes; model choices save as they change.
 */
export function CustomizeCoworker({
  runtime,
  session,
  coworker,
  focus,
  onCoworkerChanged,
  onSyncProviders,
  onOpenAccount,
  onOpenModelDefaults,
  onDone,
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  coworker: CoworkerSummary;
  /** Open on this part, e.g. the model when a reply could not use the current one. */
  focus?: CustomizeFocus;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onSyncProviders: () => Promise<ProviderSyncRun>;
  onOpenAccount: () => void;
  onOpenModelDefaults: () => void;
  onDone: () => void;
}) {
  const titleId = useId();
  const preview = `${coworker.slug}:customize`;
  /** The profile, or one of the model tabs behind "AI model, thinking and helpers". */
  const [view, setView] = useState<"profile" | ModelSettingsPart>(focus === "model" ? "model" : "profile");
  const [role, setRole] = useState(coworker.role);
  const [mission, setMission] = useState(coworker.mission);
  const [avatarColor, setAvatarColor] = useState(coworker.avatarColor);
  const [avatarGlasses, setAvatarGlasses] = useState(coworker.avatarGlasses);
  const [personality, setPersonality] = useState(coworker.personality);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus === "model") setView("model");
  }, [focus]);

  const dirty = role.trim() !== coworker.role
    || mission.trim() !== coworker.mission
    || avatarColor !== coworker.avatarColor
    || avatarGlasses !== coworker.avatarGlasses
    || personality !== coworker.personality;
  const advanced = view !== "profile";

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Escape steps back out of the model tabs first, then closes an unchanged dialog.
      event.preventDefault();
      if (advanced) setView("profile");
      else if (!dirty) onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advanced, dirty, onDone]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      onCoworkerChanged(await coworkerBridge.coworkers.update(coworker.slug, {
        role: role.trim(),
        mission: mission.trim(),
        avatarColor,
        avatarGlasses,
        personality,
      }));
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  function moveTab(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = MODEL_TABS.findIndex((item) => item.id === view);
    const next = MODEL_TABS[(index + (event.key === "ArrowRight" ? 1 : MODEL_TABS.length - 1)) % MODEL_TABS.length];
    if (!next) return;
    setView(next.id);
    window.requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  }

  const look = (
    <AvatarControls
      layout="compact"
      color={avatarColor}
      glasses={avatarGlasses}
      onColorChange={(color) => {
        setAvatarColor(color);
        if (color !== avatarColor) acknowledgeCoworker(preview);
      }}
      onGlassesChange={(glasses) => {
        setAvatarGlasses(glasses);
        if (glasses !== avatarGlasses) acknowledgeCoworker(preview);
      }}
    />
  );
  const modelSummary = [
    usesAppConversationDefault(coworker) ? "Shared model" : "Its own model",
    `${effortStopLabel(coworker.effortPreference)} thinking`,
    coworker.thinkingModel || coworker.deliveryModel ? "chosen helpers" : "",
  ].filter(Boolean).join(" · ");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-5 backdrop-blur-[2px]"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !dirty && !busy) onDone(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="customize-coworker"
        data-view={view}
        data-glint="surface"
        className={`creation-card glass-sheen window-no-drag relative grid h-[min(600px,calc(100vh-40px))] w-full max-w-[860px] overflow-hidden rounded-[26px] border border-line shadow-[0_32px_96px_rgb(0_0_0/0.6)] ${advanced ? "" : "md:grid-cols-[300px_1fr]"}`}
      >
        {/* The face and its look lead the profile; the model tabs take the whole width. */}
        {!advanced ? (
          <div className="avatar-stage hidden min-h-0 flex-col items-center overflow-y-auto border-r border-line px-4 pb-6 pt-9 md:flex">
            <CoworkerAvatar identity={preview} motion="playful" color={avatarColor} glasses={avatarGlasses} name={coworker.name} size={104} />
            <p className="mt-3 max-w-full truncate text-lg font-semibold tracking-[-0.025em] text-snow">{coworker.name}</p>
            {role.trim() ? <p className="mt-0.5 max-w-full truncate text-xs text-mist">{role.trim()}</p> : null}
            <div className="mt-6 w-full" data-testid="customize-look">{look}</div>
          </div>
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-col">
          <header className={`flex shrink-0 gap-3 px-6 pt-5 md:px-7 ${advanced ? "items-center" : "items-start"}`}>
            <span className={`pt-0.5 ${advanced ? "" : "md:hidden"}`}><CoworkerAvatar identity={`${preview}:small`} color={avatarColor} glasses={avatarGlasses} name={coworker.name} size={advanced ? 28 : 36} animated={false} /></span>
            <div className="min-w-0 flex-1">
              {advanced ? (
                <nav aria-label="Where you are" className="flex min-w-0 items-center gap-1" data-testid="customize-breadcrumbs">
                  <button type="button" className="-ml-1 flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-sm text-mist transition-colors hover:bg-white/5 hover:text-snow" onClick={() => setView("profile")} data-testid="customize-back-to-profile">
                    <ChevronIcon direction="left" className="size-3.5" />
                    Customize {coworker.name}
                  </button>
                  <ChevronIcon direction="right" className="size-3 shrink-0 text-mist/60" />
                  <h1 id={titleId} className="truncate text-sm font-semibold text-snow" aria-current="page">AI model, thinking and helpers</h1>
                </nav>
              ) : (
                <>
                  <h1 id={titleId} className="truncate text-xl font-semibold tracking-[-0.03em] text-snow">Customize {coworker.name}</h1>
                  <p className="mt-0.5 text-xs text-mist">How it looks, what it is here for, and how it talks.</p>
                </>
              )}
            </div>
            <IconButton label={dirty ? "Close without saving" : "Close"} tooltipSide="bottom" onClick={onDone} data-testid="customize-close">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="size-4" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
            </IconButton>
          </header>

          {advanced ? (
            <>
              <div ref={tabsRef} role="tablist" aria-label="AI model, thinking and helpers" className="mx-6 mt-4 flex shrink-0 gap-1 border-b border-line md:mx-7" onKeyDown={moveTab} data-testid="customize-tabs">
                {MODEL_TABS.map((item) => {
                  const selected = item.id === view;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      id={`customize-tab-${item.id}`}
                      aria-selected={selected}
                      aria-controls="customize-panel"
                      tabIndex={selected ? 0 : -1}
                      data-testid={`customize-tab-${item.id}`}
                      onClick={() => setView(item.id)}
                      className={`-mb-px border-b-2 px-2.5 pb-2.5 pt-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 ${selected ? "border-snow font-medium text-snow" : "border-transparent text-mist hover:text-snow"}`}
                    >
                      {item.title}
                    </button>
                  );
                })}
              </div>
              <div id="customize-panel" role="tabpanel" aria-labelledby={`customize-tab-${view}`} className="min-h-0 flex-1 overflow-y-auto px-6 py-5 md:px-7" data-testid="customize-panel">
                <CoworkerModelSettings
                  part={view}
                  runtime={runtime}
                  session={session}
                  coworker={coworker}
                  onCoworkerChanged={onCoworkerChanged}
                  onSyncProviders={onSyncProviders}
                  onOpenAccount={onOpenAccount}
                  onOpenModelDefaults={onOpenModelDefaults}
                />
              </div>
            </>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5 pt-5 md:px-7" data-testid="customize-profile">
              <div className="space-y-4">
                <div className="md:hidden">{look}</div>
                <Field label="Role">
                  <input className={`${inputClass} bg-ink`} value={role} placeholder="Research partner" onChange={(event) => setRole(event.target.value)} />
                </Field>
                <Field label="What it is here for">
                  <textarea className={`${inputClass} min-h-[68px] resize-none bg-ink`} rows={2} value={mission} placeholder="What should this coworker own over time?" onChange={(event) => setMission(event.target.value)} />
                </Field>
                <PersonalityPicker value={personality} seed={coworker.slug} onChange={setPersonality} />
              </div>
              <button
                type="button"
                className="group mt-5 flex w-full items-center gap-3 rounded-xl border border-line px-3.5 py-3 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60"
                onClick={() => setView("model")}
                data-testid="customize-advanced"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-snow">AI model, thinking and helpers</span>
                  <span className="mt-0.5 block truncate text-[11px] text-mist">{modelSummary}</span>
                </span>
                <ChevronIcon direction="right" className="size-3.5 shrink-0 text-mist transition-colors group-hover:text-snow" />
              </button>
            </div>
          )}

          <div className="flex shrink-0 items-center gap-2 border-t border-line px-6 py-4 md:px-7">
            {error ? <div className="min-w-0 flex-1"><ErrorNote>{error}</ErrorNote></div> : (
              <p className="min-w-0 flex-1 truncate text-xs text-mist">
                {dirty ? "Unsaved changes to the profile." : advanced ? `Model changes save right away, for ${coworker.name} only.` : ""}
              </p>
            )}
            <Button variant="ghost" onClick={onDone} disabled={busy}>{dirty ? "Cancel" : "Done"}</Button>
            {dirty ? (
              <Button variant="primary" aria-busy={busy} disabled={busy} onClick={() => void save()} data-testid="customize-save">
                {busy ? "Saving…" : "Save changes"}
              </Button>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
