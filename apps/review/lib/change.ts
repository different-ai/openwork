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

function targetWords(detail: string): string {
  const words = detail.replace(/^(?:text|label|placeholder|testId)=/, "").replace(/, hitTest=false$/, "");
  const pattern = /^\/\^?(.*?)\$?\/[a-z]*$/.exec(words)?.[1];
  const shown = pattern === undefined ? words : pattern.replace(/\\(.)/g, "$1").replace(/\.\*/g, "…");
  return /^[a-z]+$/.test(shown) ? shown : `“${shown}”`;
}

export function describeAction(action: string): string {
  const match = /^(\w+)\((.*)\)$/s.exec(action);
  if (!match) return action === "reload" ? "Reloaded the page" : action;
  const [, verb, detail] = match;
  if (verb === "type") {
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

export function describeChange(image: ImageEvidence, previousNumber?: number): string {
  const change = image.change;
  if (!change || change.since === null) return "";
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

export function isRepeat(image: ImageEvidence): boolean {
  return image.change !== undefined && image.change.since !== null && image.change.ratio === 0;
}

export function stepFound(images: ImageEvidence[], image: ImageEvidence): string[] {
  if (image.step === undefined) return (image.focus ?? []).map((entry) => entry.label);
  const labels = images.filter((entry) => entry.sourceId === image.sourceId && entry.step === image.step).flatMap((entry) => entry.focus ?? []).map((entry) => entry.label);
  return [...new Set(labels)];
}

export function stepChecks(report: Pick<ReviewReport, "evidence">, image: ImageEvidence): AssertionEvidence[] {
  if (image.step === undefined) return [];
  return report.evidence.filter((entry): entry is AssertionEvidence =>
    entry.kind === "assertion" && entry.sourceId === image.sourceId && entry.step === image.step);
}

export function closesStep(images: ImageEvidence[], index: number): boolean {
  const image = images[index];
  const next = images[index + 1];
  return image?.step !== undefined && (next === undefined || next.step !== image.step);
}
