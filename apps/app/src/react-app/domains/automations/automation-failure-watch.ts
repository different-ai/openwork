import type { AutomationList } from "@openwork/types/automations";

import { isMissedAutomationRun } from "./automation-format";

/** One notification for one failed or missed run. */
export type AutomationFailureNotice = {
  runId: string;
  automationId: string;
  name: string;
  title: string;
  body: string;
  /** Set when the run never started because no desktop picked it up. */
  missed?: { /** The Automation has runs ahead that still need a desktop. */ desktopRunsAhead: boolean };
};

/** What a missed-run notice offers: one run now, and moving the schedule to the cloud. */
export type MissedRunOffer = { run: "desktop" | "cloud" | null; moveToCloud: boolean };

const NAME_LIMIT = 80;

function shortName(name: string): string {
  const trimmed = name.trim() || "An Automation";
  return trimmed.length > NAME_LIMIT ? `${trimmed.slice(0, NAME_LIMIT - 1)}…` : trimmed;
}

/**
 * Which failed or missed runs to tell the owner about, and the new watermark.
 *
 * The watermark is the latest `finishedAt` already seen, in Den's clock, so a
 * run is announced once however often this is called, across restarts and
 * windows sharing storage. With no watermark yet (first check on this
 * computer, or the feature just turned on) nothing is announced: earlier
 * runs are history, not news. Only each Automation's latest run is known,
 * so two failures of one Automation between checks are announced once.
 *
 * A missed run is announced only while the Automation can still be run:
 * not when it is archived or waiting on a fix of its own.
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

/**
 * What the owner can do about a missed run from this app. A desktop app is
 * one of the desktops the Automation runs on, so it can run it now; a browser
 * cannot, and offers one run in the cloud instead. Moving the schedule to the
 * cloud is offered while the Automation has runs ahead that need a desktop.
 */
export function missedRunOffer(input: { desktopRunsAhead: boolean; onDesktop: boolean; cloudAvailable: boolean }): MissedRunOffer {
  return {
    run: input.onDesktop ? "desktop" : input.cloudAvailable ? "cloud" : null,
    moveToCloud: input.cloudAvailable && input.desktopRunsAhead,
  };
}

/** The missed-run message: why it did not run, then what the buttons offer. */
export function missedRunBody(reason: string, offer: MissedRunOffer): string {
  if (!offer.run) return `${reason} Keep OpenWork open and signed in on your desktop so the next run starts.`;
  const run = offer.run === "cloud" ? "Run it in the cloud now" : "Run it now";
  return offer.moveToCloud
    ? `${reason} ${run}, or move it to the cloud so it runs even when your desktop is offline.`
    : `${reason} ${run} to catch up.`;
}
