import type { UIMessage } from "ai";

export const ADMISSION_OUTCOME_GRACE_MS = 1500;

export function messageHasVisibleAssistantOutput(message: UIMessage): boolean {
  if (message.role !== "assistant") return false;
  return message.parts.some((part) => {
    if ("text" in part && typeof part.text === "string") return part.text.trim().length > 0;
    return part.type === "dynamic-tool" || part.type === "file";
  });
}

function neverAdmitted(message: UIMessage): boolean {
  const metadata = message.metadata;
  return Boolean(metadata && typeof metadata === "object" && "unprocessed" in metadata && metadata.unprocessed === true);
}

export function findLastUserMessageIndex(messages: readonly UIMessage[]): number {
  let latest = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role !== "user" || neverAdmitted(messages[index]!)) continue;
    const created = messageIdentity(messages[index]).created;
    const previous = latest < 0 ? undefined : messageIdentity(messages[latest]).created;
    if (created === undefined || previous === undefined || created >= previous) latest = index;
  }
  return latest;
}

function messageIdentity(message: UIMessage): { parentID?: string; created?: number } {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object" || !("opencode" in metadata)) return {};
  const info = metadata.opencode;
  if (!info || typeof info !== "object") return {};
  return {
    ...("parentID" in info && typeof info.parentID === "string" ? { parentID: info.parentID } : {}),
    ...("created" in info && typeof info.created === "number" && Number.isFinite(info.created) ? { created: info.created } : {}),
  };
}

export type AdmissionOutcomeInput = {
  messages: readonly UIMessage[];
  statusType: string;
  sending: boolean;
  hasActiveQuestion: boolean;
  hasActivePermission: boolean;
  hasSessionError: boolean;
};

export type AdmissionOutcome = "settled" | "pending" | "unresolved";

export function resolveAdmissionOutcome(input: AdmissionOutcomeInput): AdmissionOutcome {
  const lastUserIndex = findLastUserMessageIndex(input.messages);
  if (lastUserIndex === -1) return "settled";
  const user = input.messages[lastUserIndex];
  const answered = input.messages.some((message, index) => {
    if (!messageHasVisibleAssistantOutput(message)) return false;
    const { parentID } = messageIdentity(message);
    return parentID === undefined ? index > lastUserIndex : parentID === user.id;
  });
  if (answered) return "settled";
  if (input.hasSessionError) return "settled";
  if (input.sending || input.statusType !== "idle") return "pending";
  if (input.hasActiveQuestion || input.hasActivePermission) return "pending";
  return "unresolved";
}

export type SingleFlight = {
  readonly inFlight: boolean;
  run(task: () => Promise<void>): Promise<boolean>;
};

export function createSingleFlight(): SingleFlight {
  let inFlight = false;
  return {
    get inFlight() {
      return inFlight;
    },
    async run(task: () => Promise<void>): Promise<boolean> {
      if (inFlight) return false;
      inFlight = true;
      try {
        await task();
        return true;
      } finally {
        inFlight = false;
      }
    },
  };
}
