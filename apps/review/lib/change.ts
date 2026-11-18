import type { ReviewEvidence, ReviewReport } from "@openwork/review";

type ImageEvidence = Extract<ReviewEvidence, { kind: "image" }>;
type AssertionEvidence = Extract<ReviewEvidence, { kind: "assertion" }>;

const VERBS: Record<string, string> = {
  click: "Clicked",
  dblclick: "Double-clicked",
  rightClick: "Right-clicked",
  hover: "Pointed at",
  press: "Pressed",
  navigate: "Opened",
  run: "Ran",
};

/** The words a target was found by: `text=Advanced options` → “Advanced options”. */
function targetWords(detail: string): string {
  const words = detail.replace(/^(?:text|label|placeholder|testId)=/, "").replace(/, hitTest=false$/, "");
  // A pattern target reads as the words it matches: /^Switch to this model/ → Switch to this model.
  const pattern = /^\/\^?(.*?)\$?\/[a-z]*$/.exec(words)?.[1];
  const shown = pattern === undefined ? words : pattern.replace(/\\(.)/g, "$1").replace(/\.\*/g, "…");
  return /^[a-z]+$/.test(shown) ? shown : `“${shown}”`;
}

/** A traced action in a reviewer's words: `click(text=Save)` → `Clicked “Save”`. */
export function describeAction(action: string): string {
  const match = /^(\w+)\((.*)\)$/s.exec(action);
  if (!match) return action === "reload" ? "Reloaded the page" : action;
  const [, verb, detail] = match;
  if (verb === "type") {
    // type(<target>, "<text>"[, replace]); sensitive text is traced as <redacted>.
    const comma = detail.indexOf(", ");
    const target = comma === -1 ? detail : detail.slice(0, comma);
    const text = /^"((?:[^"\\]|\\.)*)"/.exec(comma === -1 ? "" : detail.slice(comma + 2))?.[1];
    if (text === undefined) return `Typed into ${targetWords(target)}`;
    return `Typed “${text.length > 60 ? `${text.slice(0, 59)}…` : text}” into ${targetWords(target)}`;
  }
  if (verb === "send") return "Sent a message";
  if (verb === "press") return `Pressed ${detail}`;
  const named = VERBS[verb];
  return named ? `${named} ${targetWords(detail)}` : action;
}

function quoted(lines: string[], total: number): string {
  const shown = lines.slice(0, 2).map((line) => `“${line}”`).join(" and ");
  return total > 2 ? `${shown} and ${total - 2} more ${total - 2 === 1 ? "line" : "lines"}` : shown;
}

/**
 * What an image shows that the previous one did not, in one or two plain
 * sentences: what the person did, then what appeared or went away. Empty for
 * the first image of a test or one recorded before the harness measured this.
 */
export function describeChange(image: ImageEvidence, previousNumber?: number): string {
  const change = image.change;
  if (!change || change.since === null) return "";
  // Pointer moves only matter when nothing else happened.
  const acts = change.actions.filter((action) => !action.startsWith("hover(")).length > 0
    ? change.actions.filter((action) => !action.startsWith("hover("))
    : change.actions;
  const did = acts.length > 0
    ? `${acts.slice(-2).map((action, index) => index === 0 ? describeAction(action) : `then ${describeAction(action).replace(/^[A-Z]/, (letter) => letter.toLowerCase())}`).join(", ")}. `
    : "";
  if (change.ratio === 0) return `${did}Same screen as ${previousNumber ? `screenshot ${previousNumber}` : "the previous screenshot"}.`;
  const parts = [
    change.added.length > 0 ? `${quoted(change.added, change.addedCount)} appeared` : "",
    change.removed.length > 0 ? `${quoted(change.removed, change.removedCount)} went away` : "",
  ].filter(Boolean);
  if (parts.length > 0) return `${did}${parts.join("; ")}.`;
  const area = change.ratio >= 0.01 ? `${Math.round(change.ratio * 100)}%` : "Less than 1%";
  return `${did}${area} of the screen changed.`;
}

/** Same pixels as the screenshot before it. */
export function isRepeat(image: ImageEvidence): boolean {
  return image.change !== undefined && image.change.since !== null && image.change.ratio === 0;
}

/** What the step's `user.see` calls found on screen, outlined on its images. */
export function stepFound(images: ImageEvidence[], image: ImageEvidence): string[] {
  if (image.step === undefined) return (image.focus ?? []).map((entry) => entry.label);
  const labels = images.filter((entry) => entry.sourceId === image.sourceId && entry.step === image.step).flatMap((entry) => entry.focus ?? []).map((entry) => entry.label);
  return [...new Set(labels)];
}

/** Check lines recorded in the same step as the image: the claim it illustrates. */
export function stepChecks(report: Pick<ReviewReport, "evidence">, image: ImageEvidence): AssertionEvidence[] {
  if (image.step === undefined) return [];
  return report.evidence.filter((entry): entry is AssertionEvidence =>
    entry.kind === "assertion" && entry.sourceId === image.sourceId && entry.step === image.step);
}

/** The last image of its step carries the step's checks, so a before/after pair shows them once. */
export function closesStep(images: ImageEvidence[], index: number): boolean {
  const image = images[index];
  const next = images[index + 1];
  return image?.step !== undefined && (next === undefined || next.step !== image.step);
}
