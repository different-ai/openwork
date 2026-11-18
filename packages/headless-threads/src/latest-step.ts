/**
 * The step a session ran last, as one short sentence ("Ran List the release
 * notes", "Read v1.1.md"), for status lines that say what a session on
 * another computer is doing without reading its transcript.
 *
 * Only the current turn counts: steps before the latest user message belong
 * to an earlier answer.
 */
import type { HeadlessThreadMessage, HeadlessThreadMessagePart } from "./types.js";

export const LATEST_STEP_MAX_LENGTH = 120;

type LatestStepMessage = Pick<HeadlessThreadMessage, "role"> & {
  parts: ReadonlyArray<Pick<HeadlessThreadMessagePart, "type" | "tool" | "toolTitle" | "toolInput" | "synthetic" | "ignored">>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(input: unknown, ...names: string[]): string | null {
  const record = typeof input === "string" ? parseJson(input) : input;
  if (!isRecord(record)) return null;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > LATEST_STEP_MAX_LENGTH ? `${line.slice(0, LATEST_STEP_MAX_LENGTH - 1)}…` : line;
}

/** "Verb object" for one tool call; commands show their description, never the raw command line. */
export function stepSentence(part: Pick<HeadlessThreadMessagePart, "tool" | "toolTitle" | "toolInput">): string | null {
  const tool = (part.tool ?? "").trim();
  if (!tool) return null;
  const input = part.toolInput;
  const title = part.toolTitle?.trim() || null;
  const name = tool.toLowerCase();
  if (name === "bash" || name === "shell") {
    const description = field(input, "description") ?? title;
    return description ? `Ran ${sentenceCase(description)}` : "Ran a command";
  }
  if (name === "read" || name === "write" || name === "edit" || name === "multiedit" || name === "patch") {
    const path = field(input, "filePath", "path", "file");
    const verb = name === "read" ? "Read" : name === "write" ? "Wrote" : "Edited";
    return path ? `${verb} ${fileName(path)}` : `${verb} a file`;
  }
  if (name === "grep" || name === "glob") {
    const pattern = field(input, "pattern", "query");
    return pattern ? `Searched for "${pattern}"` : "Searched files";
  }
  if (name === "websearch" || name === "web_search") {
    const query = field(input, "query");
    return query ? `Searched web ${query}` : "Searched the web";
  }
  if (name === "webfetch" || name === "fetch") {
    const url = field(input, "url");
    if (!url) return "Opened a page";
    try {
      return `Opened ${new URL(url).host}`;
    } catch {
      return `Opened ${url}`;
    }
  }
  if (name === "task") {
    const description = field(input, "description") ?? title;
    return description ? `Asked a helper to ${description.charAt(0).toLowerCase()}${description.slice(1)}` : "Asked a helper";
  }
  if (name === "todowrite" || name === "todoread") return "Updated the plan";
  return title ? sentenceCase(title) : `Used ${tool}`;
}

/** The last tool step of the current turn, or null when it has run none yet. */
export function latestStep(messages: ReadonlyArray<LatestStepMessage>): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "user") return null;
    if (message.role !== "assistant") continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (!part || part.type !== "tool" || part.synthetic === true || part.ignored === true) continue;
      const sentence = stepSentence(part);
      if (sentence) return clip(sentence);
    }
  }
  return null;
}
