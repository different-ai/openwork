import type { AutomationList } from "@openwork/types/automations";

import { isMissedAutomationRun } from "./automation-format";

export type AutomationFailureNotice = {
  runId: string;
  automationId: string;
  name: string;
  title: string;
  body: string;
  missed?: { desktopRunsAhead: boolean };
};

export type MissedRunOffer = { run: "desktop" | "cloud" | null; moveToCloud: boolean };

const NAME_LIMIT = 80;

function shortName(name: string): string {
  const trimmed = name.trim() || "An Automation";
  return trimmed.length > NAME_LIMIT ? `${trimmed.slice(0, NAME_LIMIT - 1)}…` : trimmed;
}

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
    .filter((entry) => entry.finishedAt > watermark)
    .sort((a, b) => a.finishedAt - b.finishedAt)
    .flatMap(({ item, run }): AutomationFailureNotice[] => {
      const name = shortName(item.automation.name);
      const notice = { runId: run.id, automationId: item.automation.id, name };
      if (isMissedAutomationRun(run)) {
        if (item.automation.state === "archived" || item.automation.state === "needs_attention") return [];
        return [{
          ...notice,
          title: `${name} didn't run`,
          body: run.error?.message.trim() || "No desktop picked this run up in time.",
          missed: {
            desktopRunsAhead: item.automation.state === "active" && item.automation.nextDueAt !== null
              && (item.revision.executionTarget ?? "desktop") === "desktop",
          },
        }];
      }
      if (run.status !== "failed") return [];
      const needsConnection = run.error?.code === "connection_action_required";
      return [{
        ...notice,
        title: needsConnection ? `${name} needs a connection` : `${name} failed`,
        body: run.error?.message.trim() || "The run stopped before it finished. Open it in Automations to see why.",
      }];
    });
  return { notices, watermark: latest };
}

export function missedRunOffer(input: { desktopRunsAhead: boolean; onDesktop: boolean; cloudAvailable: boolean }): MissedRunOffer {
  return {
    run: input.onDesktop ? "desktop" : input.cloudAvailable ? "cloud" : null,
    moveToCloud: input.cloudAvailable && input.desktopRunsAhead,
  };
}

export function missedRunBody(reason: string, offer: MissedRunOffer): string {
  if (!offer.run) return `${reason} Keep OpenWork open and signed in on your desktop so the next run starts.`;
  const run = offer.run === "cloud" ? "Run it in the cloud now" : "Run it now";
  return offer.moveToCloud
    ? `${reason} ${run}, or move it to the cloud so it runs even when your desktop is offline.`
    : `${reason} ${run} to catch up.`;
}
