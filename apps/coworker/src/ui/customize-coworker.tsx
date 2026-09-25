import { useEffect, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary, type ProviderSyncRun, type RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { acknowledgeCoworker, AvatarControls, CoworkerAvatar } from "@/ui/coworker-avatar";
import { CoworkerModelSettings } from "@/ui/coworker-model-settings";
import { PersonalityPicker } from "@/ui/personality-picker";
import { Button, ErrorNote, Field, inputClass } from "@/ui/kit";

export type CustomizeFocus = "model";

/**
 * Customizing a coworker is a page of its own, the way adding one is: its look,
 * role, mission and personality, and under Advanced the AI models it uses. The
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
  /** Open with this part in view, e.g. the model when a reply could not use the current one. */
  focus?: CustomizeFocus;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onSyncProviders: () => Promise<ProviderSyncRun>;
  onOpenAccount: () => void;
  onOpenModelDefaults: () => void;
  onDone: () => void;
}) {
  const preview = `${coworker.slug}:customize`;
  const [role, setRole] = useState(coworker.role);
  const [mission, setMission] = useState(coworker.mission);
  const [avatarColor, setAvatarColor] = useState(coworker.avatarColor);
  const [avatarGlasses, setAvatarGlasses] = useState(coworker.avatarGlasses);
  const [personality, setPersonality] = useState(coworker.personality);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const advancedRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (focus === "model") advancedRef.current?.scrollIntoView({ block: "start" });
  }, [focus]);

  const dirty = role.trim() !== coworker.role
    || mission.trim() !== coworker.mission
    || avatarColor !== coworker.avatarColor
    || avatarGlasses !== coworker.avatarGlasses
    || personality !== coworker.personality;

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !dirty) onDone();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [dirty, onDone]);

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

  return (
    <div className="window-shell flex h-full min-w-0 flex-1 flex-col" data-testid="customize-coworker">
      <header className="window-drag flex h-[52px] shrink-0 items-center px-4 pl-20">
        <button
          type="button"
          className="window-no-drag flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-medium text-mist transition-colors hover:bg-white/5 hover:text-snow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60"
          onClick={onDone}
        >
          <span aria-hidden="true">←</span>
          <span>Back to {coworker.name}</span>
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-8 pt-2">
        <div className="creation-card m-auto grid min-w-0 w-full max-w-3xl shrink-0 overflow-hidden rounded-[30px] border border-line md:min-h-[540px] md:grid-cols-[290px_1fr]">
          <div className="avatar-stage flex min-h-[300px] flex-col items-center justify-center border-b border-line p-7 md:justify-start md:border-b-0 md:border-r md:pt-24">
            <CoworkerAvatar identity={preview} motion="playful" color={avatarColor} glasses={avatarGlasses} name={coworker.name} size={140} />
            <p className="mt-3 max-w-full truncate text-lg font-semibold tracking-[-0.025em] text-snow">{coworker.name}</p>
            {role.trim() ? <p className="mt-1 max-w-full truncate text-xs text-mist">{role.trim()}</p> : null}
          </div>

          <div className="flex min-w-0 flex-col p-6 md:p-7">
            <h1 className="text-2xl font-semibold tracking-[-0.035em] text-snow">Customize {coworker.name}</h1>
            <p className="mt-1 max-w-sm text-sm leading-relaxed text-mist">How {coworker.name} looks, what it is here for, and how it talks.</p>
            <div className="mt-5 space-y-4">
              <AvatarControls
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
              <Field label="Role">
                <input className={`${inputClass} bg-ink`} value={role} placeholder="Research partner" onChange={(event) => setRole(event.target.value)} />
              </Field>
              <Field label="Mission">
                <textarea className={`${inputClass} min-h-20 resize-none bg-ink`} value={mission} placeholder="What should this coworker own over time?" onChange={(event) => setMission(event.target.value)} />
              </Field>
              <PersonalityPicker value={personality} seed={coworker.slug} onChange={setPersonality} />
            </div>

            <details ref={advancedRef} open={focus === "model"} className="mt-6 border-t border-line pt-4" data-testid="customize-advanced">
              <summary className="cursor-pointer text-sm font-medium text-snow">Advanced</summary>
              <p className="mt-1 text-xs text-mist">The AI models {coworker.name} uses. These save as soon as you change them.</p>
              <div className="mt-4">
                <CoworkerModelSettings
                  runtime={runtime}
                  session={session}
                  coworker={coworker}
                  onCoworkerChanged={onCoworkerChanged}
                  onSyncProviders={onSyncProviders}
                  onOpenAccount={onOpenAccount}
                  onOpenModelDefaults={onOpenModelDefaults}
                />
              </div>
            </details>

            {error ? <div className="mt-4"><ErrorNote>{error}</ErrorNote></div> : null}

            <div className="mt-auto flex items-center justify-end gap-2 pt-6">
              <Button variant="ghost" onClick={onDone} disabled={busy}>{dirty ? "Cancel" : "Done"}</Button>
              {dirty ? (
                <Button variant="primary" aria-busy={busy} disabled={busy} onClick={() => void save()} data-testid="customize-save">
                  {busy ? "Saving…" : "Save changes"}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
