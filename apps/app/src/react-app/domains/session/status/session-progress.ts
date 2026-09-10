import { isToolUIPart, type UIMessage } from "ai";

import { isTaskToolPart, taskChildSessionId, type TaskToolPart } from "../../../../lib/build-in-tools";
import { isToolPartInFlight } from "../../../../lib/tool-activity";

export const NO_NEW_ACTIVITY_AFTER_MS = 60_000;

export function activeDelegatedTasks(messages: UIMessage[]): TaskToolPart[] {
  const calls = new Map<string, TaskToolPart>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (isToolUIPart(part) && isTaskToolPart(part)) calls.set(part.toolCallId, part);
    }
  }
  // A child being idle is not evidence that the delegating tool completed.
  return [...calls.values()].filter(isToolPartInFlight);
}

/** Fixed tool categories keep context useful without reflecting arguments or payloads. */
function safeToolActivity(part: UIMessage["parts"][number]): string {
  if (!isToolUIPart(part)) return "Tool activity received";
  const name = part.type === "dynamic-tool" ? part.toolName : part.type.slice(5);
  switch (name) {
    case "bash": case "shell": return "Running a command";
    case "read": return "Reading files";
    case "write": case "edit": case "apply_patch": return "Updating files";
    case "grep": case "glob": return "Searching files";
    case "webfetch": case "websearch": return "Researching the web";
    case "task": case "subagent": return "Running a delegated task";
    case "todowrite": return "Updating the plan";
    case "question": return "Asking for input";
    default: return "Using a tool";
  }
}

type Progress = {
  revision: string;
  parts: Record<string, string>;
  label: string | null;
  timestamp: number;
  activeStartedAt: number;
};

function fingerprint(value: unknown): string {
  let hash = 2166136261;
  const text = JSON.stringify(value) ?? "";
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return String(hash >>> 0);
}

// Settled parts retain identity during streaming. Do not rehash old text or
// large tool results on every new token; the weak keys follow cache eviction.
const partFingerprints = new WeakMap<UIMessage["parts"][number], string>();
function partFingerprint(part: UIMessage["parts"][number], value: () => unknown): string {
  const cached = partFingerprints.get(part);
  if (cached !== undefined) return cached;
  const next = fingerprint(value());
  partFingerprints.set(part, next);
  return next;
}

/** Only content and lifecycle changes count. Never hash polling/timing metadata. */
export function transcriptProgress(messages: UIMessage[], previousParts: Record<string, string> = {}): Progress {
  const parts: Record<string, string> = {};
  let label: string | null = null;
  let timestamp = 0;
  let activeStartedAt = 0;
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== "assistant") continue;
    let meaningful = false;
    let active = false;
    for (const [index, part] of message.parts.entries()) {
      const key = `${message.id}:${isToolUIPart(part) ? part.toolCallId : index}`;
      let activity: string;
      if ((part.type === "text" || part.type === "reasoning") && part.text.trim()) {
        parts[key] = partFingerprint(part, () => [part.type, part.text, part.state]);
        activity = part.type === "text" ? "Response updated" : "Reasoning activity received";
      } else if (isToolUIPart(part)) {
        parts[key] = partFingerprint(part, () => [part.state, part.input,
          part.state === "output-available" ? part.output : null,
          part.state === "output-error" ? part.errorText : null]);
        if (isToolPartInFlight(part)) active = true;
        // Fixed labels, not raw arguments, outputs, prompts, or tool payloads.
        activity = part.state === "output-available" ? "Tool result received"
          : part.state === "output-error" ? "Tool reported an error"
          : safeToolActivity(part);
      } else if (part.type === "file") {
        parts[key] = partFingerprint(part, () => [part.type, part.url]);
        activity = "File output received";
      } else continue;
      if (parts[key] !== previousParts[key]) label = activity;
      meaningful = true;
    }
    if (!meaningful) continue;
    const metadata = message.metadata;
    if (!metadata || typeof metadata !== "object" || !("opencode" in metadata)) continue;
    const time = metadata.opencode;
    if (!time || typeof time !== "object") continue;
    for (const key of ["created", "completed"]) {
      const value = Reflect.get(time, key);
      if (typeof value === "number" && Number.isFinite(value)) {
        timestamp = Math.max(timestamp, value);
      }
    }
    const created = Reflect.get(time, "created");
    if (active && messageIndex > latestUserIndex && typeof created === "number" && Number.isFinite(created)) {
      activeStartedAt = activeStartedAt === 0 ? created : Math.min(activeStartedAt, created);
    }
  }
  return { revision: fingerprint(parts), parts, label, timestamp, activeStartedAt };
}

export function lastTaskProgressAt(
  own: number,
  tasks: TaskToolPart[],
  children: Record<string, { lastProgressAt: number }> | undefined,
): number {
  return tasks.reduce((latest, part) => {
    const id = taskChildSessionId(part);
    return Math.max(latest, id ? children?.[id]?.lastProgressAt ?? 0 : 0);
  }, own);
}

export function hasNoNewActivity(input: {
  active: boolean;
  waiting?: boolean;
  retrying?: boolean;
  disconnected?: boolean;
  lastProgressAt: number;
  now: number;
}): boolean {
  return input.active && !input.waiting && !input.retrying && !input.disconnected
    && input.now - input.lastProgressAt > NO_NEW_ACTIVITY_AFTER_MS;
}
