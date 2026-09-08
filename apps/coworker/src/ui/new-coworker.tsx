import { WORK_PATTERNS, rolesForPattern, teamAdvicePrompt, workPattern } from "@/lib/work-patterns";
import { slugOfName } from "@/lib/onboarding-team";
import { useEffect, useId, useRef, useState } from "react";
import { coworkerBridge, type AvatarColor, type AvatarGlasses, type CoworkerSummary, type TeamRole } from "@/lib/bridge";
import { acknowledgeCoworker, AvatarControls } from "@/ui/coworker-avatar";
import { OnboardingMascotStack } from "@/ui/onboarding-mascot";
import { DEFAULT_PERSONALITY, type Personality } from "@/lib/personalities";
import { PersonalityPicker } from "@/ui/personality-picker";
import { Button, ErrorNote, Field, inputClass } from "@/ui/kit";
import { RetiredCoworkers } from "@/ui/retired-coworkers";
import { PickTeammateTile } from "@/ui/team-cards";

type Step = "choose" | "identity" | "details";

/** How many suggested roles the Add screen offers above the blank form. */
const SUGGESTED_ROLES = 3;

/**
 * Creation establishes only a durable identity and workspace: a name and a
 * look, with an optional second step for role, mission, and personality. Each
 * step stays focused; the coworker starts on OpenWork's default AI
 * model, and that choice lives in Coworker settings once it exists. Existing
 * teams first see up to three missing roles, then customize a selected role
 * or start from scratch. Recommendations never crowd the identity form.
 */
export function NewCoworker({
  onCreated,
  onCancel,
  team = [],
  onAskTeam,
}: {
  onCreated: (coworker: CoworkerSummary) => void;
  /** Null on first run, when there is no team to go back to. */
  onCancel: (() => void) | null;
  /** The coworkers that exist, so a role someone already covers is not suggested again. */
  team?: readonly CoworkerSummary[];
  onAskTeam?: (slug: string, prompt: string) => void;
}) {
  const [step, setStep] = useState<Step>(team.length > 0 ? "choose" : "identity");
  const [name, setName] = useState("");
  const previewIdentity = useId();
  const acknowledgedName = useRef("");
  const [role, setRole] = useState("");
  const [mission, setMission] = useState("");
  const [avatarColor, setAvatarColor] = useState<AvatarColor>("blue");
  const [avatarGlasses, setAvatarGlasses] = useState<AvatarGlasses>("round");
  const [personality, setPersonality] = useState<Personality>(DEFAULT_PERSONALITY);
  const [roleId, setRoleId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [catalog, setCatalog] = useState<TeamRole[]>([]);
  const [patternId, setPatternId] = useState("");
  const [workDescription, setWorkDescription] = useState("");
  const [advisorSlug, setAdvisorSlug] = useState(team[0]?.slug ?? "");
  useEffect(() => {
    let cancelled = false;
    coworkerBridge.team.catalog()
      .then((roles) => {
        if (!cancelled) setCatalog(roles);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const takenRoles = new Set(team.map((coworker) => coworker.roleId).filter(Boolean));
  const takenSlugs = new Set(team.map((coworker) => coworker.slug));
  const suggested = rolesForPattern(catalog, patternId).filter((item) => !takenRoles.has(item.id)).slice(0, SUGGESTED_ROLES);

  /** Start from a suggested role: everything filled in, everything still editable. */
  function pick(item: TeamRole) {
    let free = item.defaultName;
    for (let suffix = 2; takenSlugs.has(slugOfName(free)); suffix += 1) free = `${item.defaultName} ${suffix}`;
    setName(free);
    acknowledgedName.current = free;
    acknowledgeCoworker(previewIdentity);
    setRole(item.role);
    setMission(item.mission);
    setAvatarColor(item.avatarColor);
    setAvatarGlasses(item.avatarGlasses);
    setPersonality(item.personality);
    setRoleId(item.id);
    setError("");
    setStep("details");
  }

  async function create() {
    if (!name.trim()) {
      setError("Give your coworker a name.");
      setStep("identity");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const fromCatalog = catalog.find((item) => item.id === roleId);
      // The catalog role travels only while the role the person kept is still that role.
      const keptRole = fromCatalog && role.trim() === fromCatalog.role ? fromCatalog.id : "";
      onCreated(
        await coworkerBridge.coworkers.create({
          name: name.trim(),
          role: role.trim(),
          mission: mission.trim(),
          avatarColor,
          avatarGlasses,
          personality,
          ...(keptRole ? { roleId: keptRole } : {}),
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
        <div className="creation-card m-auto grid min-w-0 w-full max-w-3xl shrink-0 overflow-hidden rounded-[30px] border border-line md:min-h-[540px] md:grid-cols-[290px_1fr]">
          <div className="avatar-stage flex min-h-[300px] flex-col items-center justify-center border-b border-line p-7 md:border-b-0 md:border-r">
            <OnboardingMascotStack
              variant={{ kind: "coworker", identity: previewIdentity, name: name.trim() || "New coworker", color: avatarColor, glasses: avatarGlasses }}
              size={140}
              sessionKey="new-coworker"
            />
            <p className="mt-3 max-w-full truncate text-lg font-semibold tracking-[-0.025em] text-snow">
              {name.trim() || "Your coworker"}
            </p>
            {role.trim() ? <p className="mt-1 max-w-full truncate text-xs text-mist">{role.trim()}</p> : null}
          </div>

          <div className="flex min-w-0 flex-col p-6 md:p-7" data-testid={`new-coworker-step-${step}`}>
            {step !== "details" ? (
              <>
                <h1 className="text-2xl font-semibold tracking-[-0.035em] text-snow">Add a coworker</h1>
                <p className="mt-1 max-w-sm text-sm leading-relaxed text-mist">
                  {step === "choose" ? "Choose a starting role, or create your own. Every detail is editable." : "Start with a name and a look. You can teach the job in the first assignment."}
                </p>
                {step === "choose" ? <>
                  <label className="mt-4 block text-xs text-mist">
                    Suggestions for your work
                    <select className={`${inputClass} mt-1.5 bg-ink`} aria-label="Profession" value={patternId} onChange={(event) => setPatternId(event.target.value)}>
                      <option value="">Any profession</option>
                      {WORK_PATTERNS.map((pattern) => <option key={pattern.id} value={pattern.id}>{pattern.label}</option>)}
                    </select>
                  </label>
                  {workPattern(patternId) ? <p className="mt-2 text-xs leading-relaxed text-mist" data-testid="work-pattern-outcome">{workPattern(patternId)?.outcome}</p> : null}
                  {suggested.length > 0 ? (
                    <div className="mt-4" data-testid="new-coworker-suggested">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-mist/75">Suggested · tap one to start from it</p>
                      <div className="mt-2 grid min-w-0 gap-2">
                        {suggested.map((item) => (
                          <PickTeammateTile
                            key={item.id}
                            look={{ name: item.defaultName, role: item.role, mission: item.pitch, avatarColor: item.avatarColor, avatarGlasses: item.avatarGlasses }}
                            smallPrint=""
                            onPick={() => pick(item)}
                            attributes={{ "data-role-id": item.id }}
                          />
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {team.length > 0 && onAskTeam ? (
                    <details className="mt-4 rounded-xl border border-line p-3" data-testid="coworker-team-advice">
                      <summary className="cursor-pointer text-xs font-medium text-snow">Ask AI to shape your team</summary>
                      <p className="mt-2 text-xs leading-relaxed text-mist">Describe your work. A coworker can suggest a workflow and a missing teammate; you choose who joins. Uses that coworker's current AI model.</p>
                      <label className="mt-3 block text-xs text-mist">Ask
                        <select className={`${inputClass} mt-1 bg-ink`} aria-label="Ask coworker" value={advisorSlug} onChange={(event) => setAdvisorSlug(event.target.value)}>
                          {team.map((member) => <option key={member.slug} value={member.slug}>{member.name}</option>)}
                        </select>
                      </label>
                      <textarea className={`${inputClass} mt-2 min-h-20 resize-y bg-ink`} aria-label="Your work and goals" placeholder="I run a small agency. Help me turn client research into a weekly campaign and review the results." maxLength={2000} value={workDescription} onChange={(event) => setWorkDescription(event.target.value)} />
                      <Button className="mt-2" disabled={!workDescription.trim() || !team.some((member) => member.slug === advisorSlug)} data-testid="coworker-team-advice-send" onClick={() => onAskTeam(advisorSlug, teamAdvicePrompt(workDescription, patternId))}>Ask for a recommendation</Button>
                    </details>
                  ) : null}
                </> : null}
                {step === "identity" ? <div className="mt-5 space-y-4">
                  {team.length > 0 ? <button type="button" className="text-xs text-mist hover:text-snow" onClick={() => setStep("choose")}>← Browse suggested roles</button> : null}
                  <Field label="Name">
                    <input
                      autoFocus
                      className={`${inputClass} bg-ink`}
                      value={name}
                      placeholder="Scout"
                      onChange={(event) => setName(event.target.value)}
                      onBlur={() => {
                        const next = name.trim();
                        if (next && next !== acknowledgedName.current) acknowledgeCoworker(previewIdentity);
                        acknowledgedName.current = next;
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void create();
                      }}
                    />
                  </Field>
                  <AvatarControls
                    color={avatarColor}
                    glasses={avatarGlasses}
                    onColorChange={(color) => {
                      setAvatarColor(color);
                      if (color !== avatarColor) acknowledgeCoworker(previewIdentity);
                    }}
                    onGlassesChange={(glasses) => {
                      setAvatarGlasses(glasses);
                      if (glasses !== avatarGlasses) acknowledgeCoworker(previewIdentity);
                    }}
                  />
                </div> : null}
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
              {step === "choose" ? (
                <Button variant="primary" onClick={() => setStep("identity")} data-testid="new-coworker-scratch">Start from scratch</Button>
              ) : step === "identity" ? (
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
                {onCancel && step !== "details" ? <Button variant="ghost" onClick={onCancel}>Cancel</Button> : null}
                {step !== "choose" ? <Button aria-busy={busy} variant="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
                  {busy ? "Adding…" : "Add coworker"}
                </Button> : null}
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
