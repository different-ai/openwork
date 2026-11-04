import type { AutomationList } from "@openwork/types/automations";

/** One notification for one failed run. */
export type AutomationFailureNotice = {
  runId: string;
  automationId: string;
  title: string;
  body: string;
};

const NAME_LIMIT = 80;

function shortName(name: string): string {
  const trimmed = name.trim() || "An Automation";
  return trimmed.length > NAME_LIMIT ? `${trimmed.slice(0, NAME_LIMIT - 1)}…` : trimmed;
}

/**
 * Which failed runs to tell the owner about, and the new watermark.
 *
 * The watermark is the latest `finishedAt` already seen, in Den's clock, so a
 * run is announced once however often this is called, across restarts and
 * windows sharing storage. With no watermark yet (first check on this
 * computer, or the feature just turned on) nothing is announced: earlier
 * failures are history, not news. Only each Automation's latest run is known,
 * so two failures of one Automation between checks are announced once.
 */
export function automationFailureNotices(
  items: AutomationList["items"],
  watermark: number | null,
): { notices: AutomationFailureNotice[]; watermark: number } {
  const finished = items.flatMap((item) => {
    const run = item.latestRun;
    return run && typeof run.finishedAt === "number" ? [{ item, run, finishedAt: run.finishedAt }] : [];
  });
  const latest = finished.reduce((max, entry) => Math.max(max, entry.finishedAt), watermark ?? 0);
  if (watermark === null) return { notices: [], watermark: latest };
  const notices = finished
    .filter((entry) => entry.run.status === "failed" && entry.finishedAt > watermark)
    .sort((a, b) => a.finishedAt - b.finishedAt)
    .map(({ item, run }): AutomationFailureNotice => {
      const name = shortName(item.automation.name);
      const needsConnection = run.error?.code === "connection_action_required";
      return {
        runId: run.id,
        automationId: item.automation.id,
        title: needsConnection ? `${name} needs a connection` : `${name} failed`,
        body: run.error?.message.trim() || "The run stopped before it finished. Open it in Automations to see why.",
      };
    });
  return { notices, watermark: latest };
}
