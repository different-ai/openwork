/**
 * The context rail's grammar for a coworker's current state. Kept pure so the
 * copy for every state (including the empty ones) is unit-tested; the rail
 * only renders what these return and never repeats one fact in two rows.
 */
import type { CoworkerSummary } from "./bridge";
import type { CoworkerActivity } from "./threads";

/** Compact relative time for the rail: "now", "12m", "3h", "2d"; empty when unknown. */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  if (!timestamp) return "";
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export type NowSummary = {
  /** The thread title or request the coworker is on; empty when there is nothing to name. */
  subject: string;
  note: string;
  /** Previous thread, only when it is a different thing from the subject. */
  previous: CoworkerActivity["last"] | undefined;
};

/**
 * What the Now card should say. Every field is optional on purpose: an idle
 * coworker with no history gets one line, not five ways of saying "nothing".
 */
export function describeNow(activity: CoworkerActivity | undefined): NowSummary {
  if (!activity) return { subject: "", note: "Checking status…", previous: undefined };
  const previous = activity.last && activity.last.title !== activity.detail ? activity.last : undefined;
  switch (activity.state) {
    case "working":
      return { subject: activity.detail, note: "Running now", previous };
    case "retrying":
      return { subject: activity.detail, note: "Retrying after an interruption", previous };
    case "attention":
      return {
        subject: activity.detail,
        note: activity.threadId ? "Waiting for you — open to respond" : "Waiting for you",
        previous,
      };
    case "recent":
      return { subject: activity.detail, note: "Last worked on this", previous: undefined };
    case "offline":
      return { subject: "", note: activity.detail || "OpenWork cannot read this workspace right now.", previous };
    default:
      return { subject: "", note: "Waiting for the first assignment.", previous: undefined };
  }
}

/** "claude-haiku-4-5 · High" from the persisted provider/model preference. */
export function describeModelPreference(
  coworker: Pick<CoworkerSummary, "model" | "modelVariant">,
): { value: string; hint: string } {
  if (!coworker.model) return { value: "Engine default", hint: "Follows the OpenWork default" };
  const separator = coworker.model.indexOf("/");
  const providerId = separator > 0 ? coworker.model.slice(0, separator) : "";
  const modelId = separator > 0 ? coworker.model.slice(separator + 1) : coworker.model;
  const variant = coworker.modelVariant
    ? ` · ${coworker.modelVariant.slice(0, 1).toUpperCase()}${coworker.modelVariant.slice(1)}`
    : "";
  return { value: `${modelId}${variant}`, hint: providerId };
}

/** Memory row: when working memory last changed and how many long-term notes exist. */
export function describeMemory(
  files: ReadonlyArray<{ id: string; updatedAt: number }>,
  now: number = Date.now(),
): { value: string; hint: string } {
  const working = files.find((file) => file.id === "working");
  const longTerm = files.filter((file) => file.id.startsWith("long-term/")).length;
  const age = working?.updatedAt ? relativeTime(working.updatedAt, now) : "";
  return {
    value: age ? (age === "now" ? "Updated just now" : `Updated ${age} ago`) : "Working memory",
    hint: `working.md · ${longTerm} long-term ${longTerm === 1 ? "note" : "notes"}`,
  };
}
