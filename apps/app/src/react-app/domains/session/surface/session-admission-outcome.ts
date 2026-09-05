import type { UIMessage } from "ai";

/**
 * Terminal invariant for accepted admissions.
 *
 * Every user message the session accepts must end in one of:
 * - assistant output followed by idle,
 * - a pending question or permission wait,
 * - an explicit error the error card owns,
 * - or a bounded "accepted but execution outcome unknown" recovery state.
 *
 * Plain idle with no assistant result must never silently clear the task:
 * the appended user message alone previously satisfied the transcript-length
 * check in the idle-clear effect, so the wait state vanished after ~1.2s
 * without any assistant message, error, or recovery action.
 */

/** Bounded debounce before an idle run with no assistant result is declared unresolved. */
export const ADMISSION_OUTCOME_GRACE_MS = 1500;

export function messageHasVisibleAssistantOutput(message: UIMessage): boolean {
  if (message.role !== "assistant") return false;
  return message.parts.some((part) => {
    if ("text" in part && typeof part.text === "string") return part.text.trim().length > 0;
    return part.type === "dynamic-tool" || part.type === "file";
  });
}

export function findLastUserMessageIndex(messages: readonly UIMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

export type AdmissionOutcomeInput = {
  messages: readonly UIMessage[];
  /** Engine-reported run status ("idle" | "busy" | "retry"). */
  statusType: string;
  /** Client-side submission pulse: a send is still being admitted. */
  sending: boolean;
  hasActiveQuestion: boolean;
  hasActivePermission: boolean;
  /** An explicit session error is already displayed and owns recovery. */
  hasSessionError: boolean;
};

export type AdmissionOutcome = "settled" | "pending" | "unresolved";

/**
 * Decide the terminal state of the most recent accepted admission.
 *
 * "unresolved" means the last admitted user message has no visible assistant
 * result after it while the session reports idle with no other terminal
 * surface (question, permission, error). The UI must then show a recovery
 * card after {@link ADMISSION_OUTCOME_GRACE_MS} instead of plain idle.
 *
 * Because this derives purely from the transcript and live status, the
 * recovery state is recomputed identically after a reload.
 */
export function resolveAdmissionOutcome(input: AdmissionOutcomeInput): AdmissionOutcome {
  const lastUserIndex = findLastUserMessageIndex(input.messages);
  if (lastUserIndex === -1) return "settled";
  const answered = input.messages
    .slice(lastUserIndex + 1)
    .some(messageHasVisibleAssistantOutput);
  if (answered) return "settled";
  if (input.hasSessionError) return "settled";
  if (input.sending || input.statusType !== "idle") return "pending";
  if (input.hasActiveQuestion || input.hasActivePermission) return "pending";
  return "unresolved";
}

export type SingleFlight = {
  readonly inFlight: boolean;
  /** Runs the task unless one is already in flight; returns whether it ran. */
  run(task: () => Promise<void>): Promise<boolean>;
};

/**
 * Exactly-once in-flight guard for recovery actions: while one invocation is
 * running, further invocations are dropped (not queued), so rapid repeated
 * clicks on Resume admit a single recovery prompt.
 */
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
