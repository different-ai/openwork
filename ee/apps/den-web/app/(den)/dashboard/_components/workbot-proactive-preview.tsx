import { AGENT_RESPONSIBILITY_COPY, type AgentResponsibility } from "@openwork/types/den/workbot-proactive";

/**
 * A sample message as members get it: plain text from their agent, in a DM from the Workbot Slack app. The agent
 * writes the real ones; these use a fictional meeting and company and follow the meeting lead time. Not interactive.
 */

export const PROACTIVE_PREVIEW_KINDS: { value: AgentResponsibility; label: string }[] = [
  { value: "morning_brief", label: AGENT_RESPONSIBILITY_COPY.morning_brief.label },
  { value: "meeting_prep", label: AGENT_RESPONSIBILITY_COPY.meeting_prep.label },
  { value: "calendar_changes", label: AGENT_RESPONSIBILITY_COPY.calendar_changes.label },
  { value: "waiting_on_you", label: AGENT_RESPONSIBILITY_COPY.waiting_on_you.label },
];

function sampleLines(kind: AgentResponsibility, leadMinutes: number): string[] {
  if (kind === "morning_brief") {
    return [
      "3 meetings today, first at 9:30 AM.",
      "Quarterly review at 11:00 AM needs prep: 2 people from northwind.example.",
      "Design review overlaps Hiring sync at 2:00 PM.",
    ];
  }
  if (kind === "calendar_changes") return ["Design review moved to tomorrow at 3:00 PM (was 11:00 AM). The organizer moved it."];
  if (kind === "waiting_on_you") {
    return [
      "\u201cRenewal questions\u201d from northwind.example has waited 5 hours for your reply.",
      "Want a draft? Ask Workbot.",
    ];
  }
  const startsIn = leadMinutes >= 60 ? "1 hour" : `${leadMinutes} min`;
  return [
    `Quarterly review starts in ${startsIn}, with 2 people from northwind.example.`,
    "They asked about renewal pricing last week and are waiting on the updated proposal.",
  ];
}

/** When the sample arrives: the brief at 8:02 AM, a meeting at 2:00 PM minus the lead time, the rest mid-morning. */
export function previewTime(kind: AgentResponsibility, leadMinutes: number) {
  if (kind === "morning_brief") return "8:02 AM";
  if (kind === "calendar_changes") return "10:12 AM";
  if (kind === "waiting_on_you") return "2:05 PM";
  const minutes = 14 * 60 - leadMinutes;
  const hour = Math.floor(minutes / 60);
  return `${hour > 12 ? hour - 12 : hour}:${String(minutes % 60).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

/** The DM comes from the Workbot Slack app's own bot, so members are notified. */
export function WorkbotProactivePreview({ kind, leadMinutes }: { kind: AgentResponsibility; leadMinutes: number }) {
  return (
    <div className="flex gap-3 rounded-xl bg-gray-50 px-4 py-3 text-[13px] leading-5 text-gray-900" data-testid="workbot-proactive-preview" data-kind={kind}>
      <img src="/openwork-mark.svg" alt="" className="mt-0.5 h-8 w-8 shrink-0 rounded-lg border border-gray-200 bg-white p-1.5" />
      <div className="grid min-w-0 gap-1">
        <p className="flex items-baseline gap-2">
          <span className="font-semibold">OpenWork</span>
          <span className="text-[12px] text-gray-500">{previewTime(kind, leadMinutes)}</span>
        </p>
        {sampleLines(kind, leadMinutes).map((line) => <p key={line}>{line}</p>)}
      </div>
    </div>
  );
}
