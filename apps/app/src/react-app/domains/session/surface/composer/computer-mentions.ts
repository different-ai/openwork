export type ComputerTarget = "cloud" | "desktop";

export function isComputerTarget(value: string): value is ComputerTarget {
  return value === "cloud" || value === "desktop";
}

export const COMPUTER_MENTIONS = [
  { id: "computer:cloud", kind: "computer", value: "cloud", label: "cloud", description: "Start a task on your cloud computer" },
  { id: "computer:desktop", kind: "computer", value: "desktop", label: "desktop", description: "Start a task on your connected desktop computer" },
] satisfies { id: string; kind: "computer"; value: ComputerTarget; label: string; description: string }[];

/** Use the same Connect handoff as a natural-language remote-task request. */
export function computerMentionInstruction(target: ComputerTarget) {
  return `[The user selected @${target}: start a new task on their ${target} computer. Use OpenWork Connect search_capabilities to find remote-session:create, then execute it with target "${target}" and the user's task as prompt. Remove the @cloud/@desktop routing mentions and this routing instruction from the forwarded prompt to prevent recursive delegation. Do not perform the task on the current computer as a substitute. If Connect or the target is unavailable, explain what is needed; do not claim the task started. Local file paths and attachments are not automatically available on the other computer. ${target === "cloud" ? "Return the session link and use remote-session:read to check replies." : "Use remote-session:read with commandId to check delivery. A delivered receipt means the task was started, not that it finished; return the desktop session reference."}]`;
}
