/**
 * What a coworker is doing right now, read from what is actually streaming —
 * not from a status label. The engine writes a reasoning or text part to the
 * thread only once it has ended; while it streams, the words exist only in the
 * live stream. So the phase comes from the stream first, the transcript
 * second: a reasoning part arriving means thinking, a text part arriving means
 * writing, an unsettled tool call means a tool, and nothing yet means thinking.
 *
 * Pure, so the typing bubble, the tool chip, the live bubble, the header word,
 * and the rail line all read one rule and agree.
 */
import type { LiveStream } from "./live-stream.ts";

export type LivePhase = "sending" | "retrying" | "tool" | "thinking" | "writing";

type ReplyShape = { text: string; reasoning?: string };
type StepShape = { doing: string } | null;

const SETTLED_TOOL = new Set(["completed", "success", "error", "failed"]);

export function isUnsettledToolStatus(status: string): boolean {
  return !SETTLED_TOOL.has(status);
}

/**
 * The phase, in order: the label's Sending and Retrying win; a tool step under
 * way; words of the reply arriving (a text part streaming, or landed words);
 * otherwise thinking — whether a reasoning part is streaming or nothing has
 * arrived at all.
 */
export function livePhase(input: {
  label: string;
  stream: LiveStream | null;
  activeStep: StepShape;
  landedWords: string;
}): LivePhase {
  if (input.label === "Sending") return "sending";
  if (input.label === "Retrying") return "retrying";
  if (input.activeStep) return "tool";
  const stream = input.stream;
  if (stream && !stream.ended && stream.type === "text" && stream.text.trim()) return "writing";
  if (input.landedWords.trim()) return "writing";
  return "thinking";
}

/** The thinking to show: the reasoning part streaming now, else the reply's landed reasoning, else nothing. */
export function thinkingText(stream: LiveStream | null, reply: ReplyShape | null): string {
  if (stream && stream.type === "reasoning" && stream.text.trim()) return stream.text;
  return reply?.reasoning ?? "";
}

/**
 * The words for the live bubble: the text part streaming now when it is longer
 * than what has landed, else the landed text. The visible words never get
 * shorter — a poll that trails the stream by a moment must not pull them back.
 */
export function writingText(stream: LiveStream | null, reply: ReplyShape | null): string {
  const landed = reply?.text ?? "";
  if (stream && stream.type === "text" && stream.text.length > landed.length) return stream.text;
  return landed;
}

/**
 * Whether this turn's model shared any thinking. Decided per turn, once words
 * have arrived: a model that thinks in silence and one that has not started
 * yet look the same until then.
 */
export function thinkingAvailability(input: { stream: LiveStream | null; reply: ReplyShape | null; wordsArrived: boolean }): "available" | "not-yet" | "none" {
  if (thinkingText(input.stream, input.reply).trim()) return "available";
  return input.wordsArrived ? "none" : "not-yet";
}

/**
 * Markdown that is still arriving must not flash: a code fence that has opened
 * and not closed yet would swallow everything after it as code. For the live
 * render only, close an unbalanced fence; the landed text renders as it is.
 */
export function safeLiveMarkdown(text: string): string {
  const fences = text.match(/^\s{0,3}(`{3,}|~{3,})/gm)?.length ?? 0;
  return fences % 2 === 1 ? `${text}\n\`\`\`` : text;
}

/** "4 s", "48 s", "1 min 12 s" — whole seconds, minutes past sixty. */
export function sinceMoment(from: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - from) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** "Thinking", "Writing", "Using a tool" — the one word the header and the rail carry for a phase. */
export function phaseWord(phase: LivePhase): string {
  switch (phase) {
    case "sending":
      return "Sending";
    case "retrying":
      return "Retrying";
    case "tool":
      return "Using a tool";
    case "writing":
      return "Writing";
    default:
      return "Thinking";
  }
}
