import { useState } from "react";
import { coworkerBridge, type AvatarColor, type AvatarGlasses, type CoworkerSummary } from "@/lib/bridge";
import { AvatarControls } from "@/ui/coworker-avatar";
import { OnboardingMascotStack } from "@/ui/onboarding-mascot";
import { DEFAULT_PERSONALITY, type Personality } from "@/lib/personalities";
import { PersonalityPicker } from "@/ui/personality-picker";
import { Button, ErrorNote, Field, inputClass } from "@/ui/kit";
import { RetiredCoworkers } from "@/ui/retired-coworkers";

type Step = "identity" | "details";

/**
 * Creation establishes only a durable identity and workspace: a name and a
 * look, with an optional second step for role, mission, and personality. Each
 * step fits without scrolling; the coworker starts on OpenWork's default AI
 * model, and that choice lives in Coworker settings once it exists.
 */
export function NewCoworker({
  onCreated,
  onCancel,
}: {
  onCreated: (coworker: CoworkerSummary) => void;
  /** Null on first run, when there is no team to go back to. */
  onCancel: (() => void) | null;
}) {
  const [step, setStep] = useState<Step>("identity");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [mission, setMission] = useState("");
  const [avatarColor, setAvatarColor] = useState<AvatarColor>("blue");
  const [avatarGlasses, setAvatarGlasses] = useState<AvatarGlasses>("round");
  const [personality, setPersonality] = useState<Personality>(DEFAULT_PERSONALITY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    if (!name.trim()) {
      setError("Give your coworker a name.");
      setStep("identity");
      return;
    }
    setBusy(true);
    setError("");
    try {
      onCreated(
        await coworkerBridge.coworkers.create({
          name: name.trim(),
          role: role.trim(),
          mission: mission.trim(),
          avatarColor,
          avatarGlasses,
          personality,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  const detailsCount = [role.trim(), mission.trim(), personality !== DEFAULT_PERSONALITY ? "personality" : ""].filter(Boolean).length;

  return (
    <div className="window-shell flex h-full min-w-0 flex-1 flex-col" data-testid="new-coworker">
      <header className="window-drag flex h-[52px] shrink-0 items-center px-4 pl-20">
        {onCancel ? (
          <button
            type="button"
            className="window-no-drag flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-medium text-mist transition-colors hover:bg-white/5 hover:text-snow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60"
            onClick={onCancel}
          >
            <span aria-hidden="true">←</span>
            <span>Back to your team</span>
          </button>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-8 pt-2">
        {/* m-auto centers the card and still lets it scroll from its top edge on a very short window. */}
        <div className="creation-card m-auto grid w-full max-w-3xl shrink-0 overflow-hidden rounded-[30px] border border-line md:min-h-[540px] md:grid-cols-[290px_1fr]">
          <div className="avatar-stage flex min-h-[300px] flex-col items-center justify-center border-b border-line p-7 md:border-b-0 md:border-r">
            <OnboardingMascotStack
              variant={{ kind: "coworker", name: name.trim() || "New coworker", color: avatarColor, glasses: avatarGlasses }}
              size={140}
              sessionKey="new-coworker"
            />
            <p className="mt-3 max-w-full truncate text-lg font-semibold tracking-[-0.025em] text-snow">
              {name.trim() || "Your coworker"}
            </p>
            {role.trim() ? <p className="mt-1 max-w-full truncate text-xs text-mist">{role.trim()}</p> : null}
          </div>

          <div className="flex flex-col p-6 md:p-7" data-testid={`new-coworker-step-${step}`}>
            {step === "identity" ? (
              <>
                <h1 className="text-2xl font-semibold tracking-[-0.035em] text-snow">Add a coworker</h1>
                <p className="mt-1 max-w-sm text-sm leading-relaxed text-mist">
                  Start with a name and a look. You can teach the job in the first assignment.
                </p>
                <div className="mt-6 space-y-4">
                  <Field label="Name">
                    <input
                      autoFocus
                      className={`${inputClass} bg-ink`}
                      value={name}
                      placeholder="Scout"
                      onChange={(event) => setName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void create();
                      }}
                    />
                  </Field>
                  <AvatarControls
                    color={avatarColor}
                    glasses={avatarGlasses}
                    onColorChange={setAvatarColor}
                    onGlassesChange={setAvatarGlasses}
                  />
                </div>
              </>
            ) : (
              <>
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-spark">Optional</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-[-0.035em] text-snow">Role, mission, and personality</h1>
                <p className="mt-1 max-w-sm text-sm leading-relaxed text-mist">
                  Everything here can be changed later in Coworker settings.
                </p>
                <div className="mt-5 space-y-3">
                  <Field label="Role">
                    <input
                      autoFocus
                      className={`${inputClass} bg-ink`}
                      value={role}
                      placeholder="Research partner"
                      onChange={(event) => setRole(event.target.value)}
                    />
                  </Field>
                  <Field label="Mission">
                    <textarea
                      className={`${inputClass} min-h-20 resize-none bg-ink`}
                      value={mission}
                      placeholder="What should this coworker own over time?"
                      onChange={(event) => setMission(event.target.value)}
                    />
                  </Field>
                  <PersonalityPicker value={personality} seed={name.trim() || "coworker"} onChange={setPersonality} />
                </div>
              </>
            )}

            {error ? <div className="mt-4"><ErrorNote>{error}</ErrorNote></div> : null}

            <div className="mt-auto flex items-center justify-between gap-3 pt-6">
              {step === "identity" ? (
                <button
                  type="button"
                  className="rounded-lg px-1 py-1 text-xs font-medium text-spark hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60"
                  onClick={() => setStep("details")}
                  data-testid="new-coworker-details-step"
                >
                  {detailsCount > 0 ? `Optional details · ${detailsCount} added` : "Add role, mission, or personality"}
                  <span aria-hidden="true"> →</span>
                </button>
              ) : (
                <Button variant="ghost" onClick={() => setStep("identity")}>
                  <span aria-hidden="true">← </span>Back
                </Button>
              )}
              <div className="flex items-center gap-2">
                {onCancel && step === "identity" ? <Button variant="ghost" onClick={onCancel}>Cancel</Button> : null}
                <Button aria-busy={busy} variant="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
                  {busy ? "Adding…" : "Add coworker"}
                </Button>
              </div>
            </div>
          </div>
        </div>
        <div className="mx-auto w-full max-w-3xl shrink-0">
          <RetiredCoworkers onRestored={onCreated} />
        </div>
      </div>
    </div>
  );
}
