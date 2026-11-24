import { DenSectionHeader } from "../../../_components/ui/section-header";
import type { McpToolCallOutcome } from "./tool-call-inspector";

type StoredRunBase = {
  id: string;
  connectionId: string;
  toolName: string;
  argumentsText: string;
  createdAt: number;
};

export type StoredToolRun = StoredRunBase & (
  | { status: "completed" | "failed"; outcome: McpToolCallOutcome }
  | { status: "policy_blocked"; message: string; disabledBy: string | null; disabledAt: string | null }
);

function runAge(createdAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function RecentToolRuns({
  runs,
  caption,
  onLoad,
}: {
  runs: StoredToolRun[];
  caption: string;
  onLoad: (run: StoredToolRun) => void;
}) {
  return (
    <section className="space-y-3 pt-2">
      <DenSectionHeader
        title="Recent runs"
        description={caption}
      />
      <div className="overflow-x-auto rounded-2xl border border-gray-100 bg-white">
        {runs.length === 0 ? (
          <p className="px-4 py-5 text-[12px] text-gray-500">Run a tool to see its session history here.</p>
        ) : runs.map((run) => {
          const summary = run.status === "completed"
            ? "Completed"
            : run.status === "policy_blocked"
              ? "Blocked — tool disabled by org policy"
              : run.outcome.failureAttribution?.summary ?? run.outcome.errorMessage ?? "Tool call failed";
          const duration = run.status === "policy_blocked" ? "—" : `${run.outcome.durationMs} ms`;
          return (
            <div key={run.id} className="flex min-w-[620px] items-center gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0">
              <span className={`h-2 w-2 shrink-0 rounded-full ${run.status === "completed" ? "bg-emerald-500" : "bg-red-400"}`} aria-hidden="true" />
              <span className="w-[140px] shrink-0 truncate font-mono text-[11px] text-gray-700">{run.toolName}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-gray-600">{summary}</span>
              <span className="w-16 shrink-0 text-right font-mono text-[10px] text-gray-500">{duration}</span>
              <span className="w-[72px] shrink-0 text-right text-[11px] text-gray-500">{runAge(run.createdAt)}</span>
              <button type="button" className="w-12 shrink-0 text-right text-[11px] font-medium text-gray-700 hover:text-gray-950" onClick={() => onLoad(run)}>Load</button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
