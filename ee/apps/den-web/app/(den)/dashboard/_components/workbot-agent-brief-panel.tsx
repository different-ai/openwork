"use client";

import { DenSelect } from "../../_components/ui/select";

/**
 * Manage › Workbot › Members' agents with Your agent's brief (`workbotAgentBrief`): one rhythm ("Check every 2 hours,
 * 8 AM–7 PM, weekdays"), the daily limit, the extra checks agents may ask for, and what to tell people as one text
 * the agents read. Replaces the four message types, the meeting lead time and the organization instructions, which
 * are carried into the text until an admin saves it. Where messages go and what agents read stay as they are.
 * A team's Workbot tab shows the same rows for the team's policy (`scope`).
 */

export function hourLabel(hour: number) {
  const h = hour % 24;
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
}

export function everyLabel(hours: number) {
  return hours === 1 ? "Every hour" : `Every ${hours} hours`;
}

/** The send check's rows (`workbotAgentSendCheck`), for the agent settings. */
export const SEND_CHECK_ROW = {
  label: "Check each message before sending",
  help: "A second, fast model reads each message before it is sent and holds one your instructions say to leave out, or that repeats what the agent already said today. It never writes or changes a message, and it keeps nothing it reads.",
  notReady: "Not set up on this deployment. Ask your deployment administrator.",
  thresholdLabel: "Hold a message only when at least this sure",
  thresholdHelp: "A message is held only when the check is at least this sure it should not be sent. Higher sends more messages; lower holds more.",
} as const;

/** A threshold as people read it: 0.2 is "20%". */
export function percentLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** The thresholds a select offers: the standard choices, plus the saved one when it was set through the API. */
export function thresholdChoices(choices: readonly number[], saved: number): number[] {
  return [...new Set([...choices, saved])].sort((left, right) => left - right);
}

/** One threshold select; the value shown is the saved one, else the default. */
export function ThresholdSelect({ labelledBy, choices, value, fallback, disabled, onChange }: {
  labelledBy: string;
  choices: readonly number[];
  value: number | undefined;
  fallback: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const shown = value ?? fallback;
  return (
    <div className="w-28">
      <DenSelect aria-labelledby={labelledBy} menuWidth="trigger" value={String(shown)} disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}>
        {thresholdChoices(choices, shown).map((choice) => <option key={choice} value={String(choice)}>{percentLabel(choice)}</option>)}
      </DenSelect>
    </div>
  );
}

/** The check gate's rows (`workbotAgentCheckGate`), for the agent settings. */
export const CHECK_GATE_ROW = {
  label: "Skip checks when nothing new arrived",
  help: "Before a scheduled check, Workbot looks at what reached the member's Gmail and Google Calendar since the last one. With nothing new, or only routine mail, the agent doesn't run. The first check of the day and checks the agent asked for always run, and so does a check after two skipped in a row.",
  thresholdLabel: "Skip only when the chance new mail matters is at most",
  thresholdHelp: "When mail arrived, the check is skipped only if the chance that any of it matters is at or below this. Lower runs the agent more often; higher skips more.",
} as const;

/** A sample message in the brief's voice, as members get it in their Workbot DM. Fictional names; not interactive. */
export function BriefPreview() {
  return (
    <div className="flex gap-3 rounded-xl bg-gray-50 px-4 py-3 text-[13px] leading-5 text-gray-900" data-testid="workbot-agent-brief-preview">
      <img src="/openwork-mark.svg" alt="" className="mt-0.5 h-8 w-8 shrink-0 rounded-lg border border-gray-200 bg-white p-1.5" />
      <div className="grid min-w-0 gap-1">
        <p className="flex items-baseline gap-2">
          <span className="font-semibold">OpenWork</span>
          <span className="text-[12px] text-gray-500">1:45 PM</span>
        </p>
        <p>
          Before your 2 PM with Northwind Labs: Dana asked in Slack for the updated pricing sheet and is still waiting. I checked your sent mail and found nothing since Tuesday. Want me to draft a reply?{" "}
          <span className="font-medium underline underline-offset-2">Slack message</span>
        </p>
      </div>
    </div>
  );
}
