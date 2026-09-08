import { WORK_PATTERNS, workPattern } from "@/lib/work-patterns";
import type { TeamRole } from "@/lib/bridge";
import { Button } from "@/ui/kit";

/**
 * "What will your team help with?" — six tiles, pick one or more, in the order
 * picked. The picks decide which coworkers the next step proposes. A quiet
 * link skips the proposal and goes to the blank Add screen instead.
 */
export function OnboardingIntents({
  catalog,
  selected,
  onToggle,
  patternId,
  onPattern,
  onContinue,
  onOwn,
  onBack,
}: {
  catalog: TeamRole[];
  selected: string[];
  patternId: string;
  onPattern: (id: string) => void;
  onToggle: (id: string) => void;
  onContinue: () => void;
  /** Skip the proposed team and add a coworker by hand. */
  onOwn: () => void;
  onBack: () => void;
}) {
  return (
    <div className="window-shell flex h-full min-h-[560px] flex-col overflow-y-auto" data-testid="onboarding-intents">
      <header className="window-drag flex h-[52px] shrink-0 items-center px-4 pl-20">
        <button
          type="button"
          className="window-no-drag flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-medium text-mist transition-colors hover:bg-white/5 hover:text-snow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60"
          onClick={onBack}
          data-testid="onboarding-intents-back"
        >
          <span aria-hidden="true">←</span>
          <span>Back</span>
        </button>
      </header>
      <main className="window-no-drag flex flex-1 items-center justify-center px-6 py-8">
        <section className="w-full max-w-[720px]">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-spark">Your team</p>
          <h1 className="mt-2 text-[32px] font-semibold leading-[1.08] tracking-[-0.045em] text-snow md:text-[36px]">What will your team help with?</h1>
          <p className="mt-2 text-sm leading-6 text-mist">Pick one or more. You can change your team any time.</p>

          <label className="mt-5 block text-xs text-mist">
            Start from your profession
            <select className="mt-1.5 block w-full rounded-xl border border-line bg-panel px-3 py-2.5 text-sm text-snow" aria-label="Profession" value={patternId} onChange={(event) => onPattern(event.target.value)}>
              <option value="">Choose my own roles</option>
              {WORK_PATTERNS.map((pattern) => <option key={pattern.id} value={pattern.id}>{pattern.label}</option>)}
            </select>
          </label>
          {workPattern(patternId) ? <p className="mt-2 text-xs leading-relaxed text-mist" data-testid="work-pattern-outcome">{workPattern(patternId)?.outcome} Adjust the roles below. Nothing is scheduled automatically.</p> : null}
          <div className="mt-5 grid gap-2.5 sm:grid-cols-2" role="group" aria-label="What your team will help with">
            {catalog.map((role) => {
              const picked = selected.includes(role.id);
              return (
                <button
                  key={role.id}
                  type="button"
                  className={`flex min-w-0 min-h-[104px] [overflow-wrap:anywhere] flex-col rounded-[18px] border px-4 py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50 ${
                    picked ? "border-spark/55 bg-spark/12" : "border-white/10 bg-panel/60 hover:border-white/18 hover:bg-white/[0.04]"
                  }`}
                  aria-pressed={picked}
                  data-testid="onboarding-intent"
                  data-intent={role.id}
                  onClick={() => onToggle(role.id)}
                >
                  <span className="flex w-full items-start justify-between gap-2">
                    <span className="min-w-0 text-[14px] font-semibold leading-snug text-snow">{role.role}</span>
                    <span
                      className={`flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${picked ? "border-spark bg-spark text-white" : "border-white/20 text-transparent"}`}
                      aria-hidden="true"
                    >
                      ✓
                    </span>
                  </span>
                  <span className="mt-1.5 text-[12px] leading-relaxed text-mist">{role.pitch}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-8 flex items-center justify-between gap-3">
            <button
              type="button"
              className="rounded-lg px-1 py-1 text-xs font-medium text-mist hover:text-snow hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60"
              onClick={onOwn}
              data-testid="onboarding-intents-own"
            >
              I'll add my own
            </button>
            <Button variant="primary" disabled={selected.length === 0} onClick={onContinue} data-testid="onboarding-intents-continue">
              Continue
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}
