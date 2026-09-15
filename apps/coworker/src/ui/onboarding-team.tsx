import { useEffect, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary, type TeamDraft, type TeamRole } from "@/lib/bridge";
import {
  addDraft,
  clearOnboardingDraft,
  draftsToCreate,
  firstNoteFor,
  remainingRoles,
  removeDraft,
  renameDraft,
  saveOnboardingDraft,
  slugOfName,
  type OnboardingDraft,
} from "@/lib/onboarding-team";
import { Button, ErrorNote } from "@/ui/kit";
import { OnboardingMascotStack } from "@/ui/onboarding-mascot";
import { EditableTeammateTile } from "@/ui/team-cards";

type Phase = { kind: "meet" } | { kind: "creating"; done: string[] } | { kind: "failed"; draft: TeamDraft; error: string; done: string[] };

/**
 * "Meet your team" — the two or three coworkers proposed from what the person
 * picked, as live cards: rename anyone in place, remove, add another role.
 * "Create my team" makes them one by one behind a calm preparation screen. The
 * draft lives in session storage under a stable id, so Back, forward, or a
 * crash mid-way loses nothing and creates nothing twice; one failure names the
 * coworker and offers Retry or Remove from team, never rolling the others back.
 */
export function OnboardingTeam({
  catalog,
  draft,
  onChange,
  onCreated,
  onBack,
}: {
  catalog: TeamRole[];
  draft: OnboardingDraft;
  onChange: (draft: OnboardingDraft) => void;
  /** Every coworker of the team exists now; the first one opens. */
  onCreated: (coworkers: CoworkerSummary[], firstSlug: string) => void;
  onBack: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "meet" });
  const [adding, setAdding] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const storage = typeof window !== "undefined" ? window.sessionStorage : null;

  useEffect(() => {
    saveOnboardingDraft(storage, draft);
  }, [draft, storage]);

  const update = (drafts: TeamDraft[]) => onChange({ ...draft, drafts });
  const remaining = remainingRoles(catalog, draft.drafts);

  async function createTeam() {
    const current = draftRef.current;
    const done = [...current.createdSlugs];
    setPhase({ kind: "creating", done });
    let existing: CoworkerSummary[] = [];
    try {
      existing = await coworkerBridge.coworkers.list();
    } catch {
      existing = [];
    }
    const firstNote = firstNoteFor(current.intents, catalog);
    for (const item of draftsToCreate(current.drafts, done, existing.map((coworker) => coworker.slug))) {
      try {
        await coworkerBridge.coworkers.create({
          name: item.name,
          role: item.role,
          mission: item.mission,
          avatarColor: item.avatarColor,
          avatarGlasses: item.avatarGlasses,
          personality: item.personality,
          roleId: item.roleId,
          firstNote,
        });
        done.push(slugOfName(item.name));
        const next = { ...draftRef.current, createdSlugs: [...done] };
        draftRef.current = next;
        onChange(next);
        setPhase({ kind: "creating", done: [...done] });
      } catch (cause) {
        setPhase({ kind: "failed", draft: item, error: cause instanceof Error ? cause.message : String(cause), done: [...done] });
        return;
      }
    }
    const team = await coworkerBridge.coworkers.list().catch(() => existing);
    const wanted = new Set(current.drafts.map((item) => slugOfName(item.name)));
    const created = team.filter((coworker) => wanted.has(coworker.slug));
    clearOnboardingDraft(storage);
    onCreated(created, slugOfName(current.drafts[0]?.name ?? ""));
  }

  if (phase.kind !== "meet") {
    const visitors = draft.drafts.slice(0, 2).map((item) => ({ name: item.name, color: item.avatarColor, glasses: item.avatarGlasses }));
    return (
      <div className="window-shell window-drag flex h-full min-h-[560px] flex-col items-center justify-center overflow-y-auto px-6 py-10" data-testid="onboarding-team-preparing" data-phase={phase.kind}>
        <OnboardingMascotStack variant={{ kind: "mark", label: "Open Coworker" }} size={96} sessionKey="onboarding-team-preparing" visitors={visitors} reveal="hold" />
        <h1 className="mt-6 text-2xl font-semibold tracking-[-0.035em] text-snow">{phase.kind === "failed" ? `${phase.draft.name} could not join yet` : "Getting your team ready"}</h1>
        <ol className="mt-4 space-y-1 text-sm text-mist" aria-live="polite">
          {draft.drafts.map((item) => {
            const slug = slugOfName(item.name);
            const made = phase.done.includes(slug);
            return (
              <li key={slug} className="flex items-center gap-2" data-testid="onboarding-team-progress" data-slug={slug} data-state={made ? "ready" : "waiting"}>
                <span className={`inline-block size-1.5 rounded-full ${made ? "bg-mint" : "bg-mist/50"}`} aria-hidden="true" />
                <span className={made ? "text-snow" : ""}>{item.name}</span>
                <span className="text-mist/70">· {item.role}</span>
              </li>
            );
          })}
        </ol>
        {phase.kind === "failed" ? (
          <div className="window-no-drag mt-6 w-full max-w-md space-y-3">
            <ErrorNote>{phase.error}</ErrorNote>
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                data-testid="onboarding-team-remove-failed"
                onClick={() => {
                  const index = draft.drafts.findIndex((item) => slugOfName(item.name) === slugOfName(phase.draft.name));
                  const remainingDrafts = index >= 0 ? draft.drafts.filter((_, position) => position !== index) : draft.drafts;
                  if (remainingDrafts.length === 0) {
                    onChange({ ...draft, drafts: remainingDrafts });
                    setPhase({ kind: "meet" });
                    return;
                  }
                  const next = { ...draft, drafts: remainingDrafts };
                  draftRef.current = next;
                  onChange(next);
                  void createTeam();
                }}
              >
                Remove from team
              </Button>
              <Button variant="primary" data-testid="onboarding-team-retry" onClick={() => void createTeam()}>
                Retry
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="window-shell flex h-full min-h-[560px] flex-col overflow-y-auto" data-testid="onboarding-team">
      <header className="window-drag flex h-[52px] shrink-0 items-center px-4 pl-20">
        <button
          type="button"
          className="window-no-drag flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-medium text-mist transition-colors hover:bg-white/5 hover:text-snow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60"
          onClick={onBack}
          data-testid="onboarding-team-back"
        >
          <span aria-hidden="true">←</span>
          <span>Back</span>
        </button>
      </header>
      <main className="window-no-drag flex flex-1 items-center justify-center px-6 py-8">
        <section className="w-full max-w-[560px]">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-spark">Your team</p>
          <h1 className="mt-2 text-[32px] font-semibold leading-[1.08] tracking-[-0.045em] text-snow md:text-[36px]">Meet your team</h1>
          <p className="mt-2 text-sm leading-6 text-mist">Rename anyone by tapping the name. You can change the rest later.</p>

          <div className="mt-6 space-y-2.5" data-testid="onboarding-team-cards">
            {draft.drafts.map((item, index) => (
              <EditableTeammateTile
                key={`${item.roleId}-${index}`}
                look={{ name: item.name, role: item.role, mission: item.mission, avatarColor: item.avatarColor, avatarGlasses: item.avatarGlasses }}
                defaultName={catalog.find((role) => role.id === item.roleId)?.defaultName ?? item.name}
                smallPrint={index === 0 ? "Coworker · Opens first" : "Coworker"}
                onNameChange={(name) => update(renameDraft(draft.drafts, index, name, catalog))}
                onRemove={draft.drafts.length > 1 ? () => update(removeDraft(draft.drafts, index)) : undefined}
                attributes={{ "data-role-id": item.roleId }}
              />
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {remaining.length > 0 ? (
              adding ? (
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Add another">
                  {remaining.map((role) => (
                    <button
                      key={role.id}
                      type="button"
                      className="min-h-8 max-w-full rounded-full border border-spark/30 bg-spark/6 px-3.5 py-1.5 text-left text-[13px] [overflow-wrap:anywhere] font-medium text-snow/90 transition-colors hover:bg-spark/14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50"
                      data-testid="onboarding-team-add-role"
                      data-role-id={role.id}
                      onClick={() => {
                        update(addDraft(draft.drafts, role));
                        setAdding(false);
                      }}
                    >
                      {role.role}
                    </button>
                  ))}
                  <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => setAdding(false)}>Cancel</Button>
                </div>
              ) : (
                <Button variant="ghost" className="px-2.5 py-1 text-xs" data-testid="onboarding-team-add" onClick={() => setAdding(true)}>
                  + Add another
                </Button>
              )
            ) : null}
          </div>

          <div className="mt-8 flex items-center justify-end gap-3">
            <Button variant="primary" disabled={draft.drafts.length === 0} onClick={() => void createTeam()} data-testid="onboarding-team-create">
              Create my team
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}
