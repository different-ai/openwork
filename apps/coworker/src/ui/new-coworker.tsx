import { WORK_PATTERNS, rolesForPattern, teamAdvicePrompt, workPattern } from "@/lib/work-patterns";
import { slugOfName } from "@/lib/onboarding-team";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { coworkerBridge, type AvatarColor, type AvatarGlasses, type CoworkerSummary, type RuntimeInfo, type TeamRole } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { resolveModelPreview, type ModelChoicePreview } from "@/lib/model-choice";
import { createCoworkerThreads, type EngineModelCatalog } from "@/lib/threads";
import { ModelPicker, type ModelSelection } from "@/ui/model-picker";
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
 * look, with an optional second step for role, mission, and personality, and
 * under Advanced there, the AI model. Each step stays focused; without a
 * choice the coworker starts on Automatic, and every choice stays editable on
 * its Customize page. Existing teams first see up to three missing roles, then
 * customize a selected role or start from scratch. Recommendations never crowd
 * the identity form.
 */
export function NewCoworker({
  runtime,
  session,
  onCreated,
  onCancel,
  team = [],
  onAskTeam,
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
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
  /** Null is Automatic. */
  const [model, setModel] = useState<ModelSelection | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
      const created = await coworkerBridge.coworkers.create({
        name: name.trim(),
        role: role.trim(),
        mission: mission.trim(),
        avatarColor,
        avatarGlasses,
        personality,
        ...(keptRole ? { roleId: keptRole } : {}),
      });
      onCreated(model ? await coworkerBridge.coworkers.update(created.slug, { model: model.model, modelVariant: model.modelVariant, modelChosenBy: "person", useAppModelDefaults: false }) : created);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  const detailsCount = [role.trim(), mission.trim(), personality !== DEFAULT_PERSONALITY ? "personality" : "", model ? "model" : ""].filter(Boolean).length;

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
        <div className="creation-card glass-sheen relative m-auto grid min-w-0 w-full max-w-3xl shrink-0 overflow-hidden rounded-[30px] border border-line md:min-h-[540px] md:grid-cols-[290px_1fr]" data-glint="surface">
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
                  Everything here can be changed later on the coworker's Customize page.
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
                <details className="mt-5 border-t border-line pt-4" data-testid="new-coworker-advanced" onToggle={(event) => { if (event.currentTarget.open) setAdvancedOpen(true); }}>
                  <summary className="cursor-pointer text-sm font-medium text-snow">Advanced</summary>
                  <p className="mt-1 text-xs text-mist">The AI model {name.trim() || "this coworker"} answers with. Automatic chooses one for you.</p>
                  {advancedOpen ? <div className="mt-3"><StartingModel runtime={runtime} session={session} value={model} onChange={setModel} /></div> : null}
                </details>
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

/** The model a new coworker starts on, from the models connected to this app; nothing is read until Advanced opens. */
function StartingModel({ runtime, session, value, onChange }: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  value: ModelSelection | null;
  onChange: (value: ModelSelection | null) => void;
}) {
  const [catalog, setCatalog] = useState<EngineModelCatalog>({ models: [], connectedProviderIds: [], cloud: null });
  const [preview, setPreview] = useState<ModelChoicePreview | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (!runtime.engineManaged) throw new Error("The AI service is not running yet.");
      const [{ workspaceId }, settings] = await Promise.all([coworkerBridge.coordinator.ensure(), coworkerBridge.settings.get()]);
      const next = await createCoworkerThreads({ serverUrl: runtime.serverUrl, workspaceId, token: runtime.ownerToken }).listModelCatalog();
      setCatalog(next);
      setPreview(resolveModelPreview(next, "conversation", settings.modelDefaults));
    } catch (cause) {
      setError(`Models could not be read. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setLoading(false);
    }
  }, [runtime.engineManaged, runtime.ownerToken, runtime.serverUrl]);
  useEffect(() => { void refresh(); }, [refresh]);
  return (
    <div className="space-y-2">
      <ModelPicker
        runtime={runtime}
        session={session}
        catalog={catalog}
        catalogLoading={loading}
        onRefreshCatalog={refresh}
        defaultPurpose="conversation"
        value={value?.model ?? ""}
        modelVariant={value?.modelVariant ?? ""}
        automaticPreview={preview}
        previewLoading={loading}
        compact
        onChange={(selection) => onChange(selection.model ? selection : null)}
      />
      {error ? <p role="status" className="text-[11px] leading-relaxed text-amber">{error}</p> : null}
    </div>
  );
}
