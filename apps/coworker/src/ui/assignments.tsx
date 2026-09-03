import type { CoworkerSummary, LocalResponsibility } from "@/lib/bridge";
import { relativeTime } from "@/lib/activity-summary";
import { onceOnlyAssignments } from "@/lib/coworker-summary";
import type { DenSession } from "@/lib/den";
import type { ThreadListItem } from "@/lib/threads";
import { Button, StatusDot } from "@/ui/kit";
import { ResponsibilitiesPanel } from "@/ui/responsibilities";

/**
 * The Assignments level of Activity: every one-off assignment the coworker
 * owns, newest first, then the ones on a schedule. New assignment hands the
 * composer an empty assignment to fill in; Add assignment (below) schedules one.
 */
export function AssignmentsPanel({
  session,
  coworkers,
  coworker,
  assignments,
  attentionBySession = {},
  scheduled,
  onScheduledChanged,
  onCoworkerChanged,
  onConnect,
  onOpenThread,
  onExplain,
  onNewAssignment,
}: {
  session: DenSession | null;
  coworkers: CoworkerSummary[];
  coworker: CoworkerSummary;
  /** The coworker's one-off assignment threads, newest first. */
  assignments: ThreadListItem[];
  /** What each assignment is waiting on the person for, by thread. */
  attentionBySession?: Record<string, string>;
  /** Scheduled assignments on this Mac, read by the home so the summary line and this list share one read. */
  scheduled: LocalResponsibility[];
  onScheduledChanged: (items: LocalResponsibility[]) => void;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  /** Start the OpenWork sign-in flow (for assignments that run in OpenWork Cloud). */
  onConnect: () => void;
  /** Open an assignment or a run's thread in the conversation column. */
  onOpenThread: (threadId: string) => void;
  /** Prefill the discussion composer with a message about a run; the person still sends it. */
  onExplain: (message: string) => void;
  /** Put the composer into assignment mode with nothing typed yet. */
  onNewAssignment: () => void;
}) {
  const once = onceOnlyAssignments(assignments, scheduled);
  return (
    <section aria-label="Assignments" className="flex min-h-full flex-col gap-5" data-testid="coworker-assignments">
      <div>
        <div className="mb-1 flex items-center justify-between gap-3 px-1">
          <h3 className="text-[11px] font-semibold text-mist">Once</h3>
          <Button variant="ghost" className="px-2 text-xs" onClick={onNewAssignment} data-testid="new-assignment-button">New assignment</Button>
        </div>
        {once.length === 0 ? (
          <p className="px-1 py-2 text-xs leading-relaxed text-mist" data-testid="assignments-empty">
            Nothing handed over yet. Talk things through, then turn a clear outcome into work {coworker.name} owns.
          </p>
        ) : (
          <ul className="divide-y divide-line" data-testid="assignment-list">
            {once.map((item) => {
              const attention = attentionBySession[item.id];
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className="group flex w-full items-center gap-3 px-1 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
                    onClick={() => onOpenThread(item.id)}
                    data-testid="assignment-row"
                    data-status={attention ? "needs-you" : item.status}
                  >
                    <StatusDot tone={attention ? "amber" : item.status === "busy" ? "spark" : item.status === "retry" ? "amber" : "mint"} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-snow">{item.title}</span>
                      <span className={`mt-0.5 block truncate text-[11px] ${attention ? "font-medium text-amber" : "text-mist"}`}>
                        {attention
                          ? "Needs you"
                          : item.status === "busy"
                            ? "Working on it"
                            : item.status === "retry"
                              ? "Retrying"
                              : `Done ${relativeTime(item.updatedAt) || "now"} ago`}
                      </span>
                    </span>
                    <span className="shrink-0 text-mist transition-colors group-hover:text-snow" aria-hidden="true">›</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <ResponsibilitiesPanel
        session={session}
        coworkers={coworkers}
        coworker={coworker}
        localItems={scheduled}
        onLocalItemsChanged={onScheduledChanged}
        onCoworkerChanged={onCoworkerChanged}
        onConnect={onConnect}
        onOpenThread={onOpenThread}
        onExplain={onExplain}
      />
    </section>
  );
}
