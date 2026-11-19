export type ComputerTarget = "cloud" | "desktop";

export function isComputerTarget(value: string): value is ComputerTarget {
  return value === "cloud" || value === "desktop";
}

export const COMPUTER_MENTIONS = [
  { id: "computer:cloud", kind: "computer", value: "cloud", label: "cloud", description: "Start a task on your cloud computer" },
  { id: "computer:desktop", kind: "computer", value: "desktop", label: "desktop", description: "Start a task on your connected desktop computer" },
] satisfies { id: string; kind: "computer"; value: ComputerTarget; label: string; description: string }[];

/** How earlier versions told the model to start the task; kept so their sent messages still read as one pill. */
const SEARCH_FIRST_START = (target: ComputerTarget) =>
  `Use OpenWork Connect search_capabilities to find remote-session:create, then execute it with target "${target}" and the user's task as prompt.`;

/** Connect lists remote-session create as its own tool for some organizations and behind search for others. */
const CURRENT_START = (target: ComputerTarget) =>
  `Start it with OpenWork Connect's remote-session create tool, passing target "${target}" and the user's task as prompt; when Connect lists no such tool, find remote-session:create with search_capabilities and execute it the same way.`;

function instruction(target: ComputerTarget, start: string) {
  const after = "OpenWork shows the started task in this chat with its progress, questions and answer: once it is created, tell the person where it runs and end your turn instead of checking on it.";
  return `[The user selected @${target}: start a new task on their ${target} computer. ${start} Remove the @cloud/@desktop routing mentions and this routing instruction from the forwarded prompt to prevent recursive delegation. Do not perform the task on the current computer as a substitute. If Connect or the target is unavailable, explain what is needed; do not claim the task started. Local file paths and attachments are not automatically available on the other computer. ${after}]`;
}

/** Use the same Connect handoff as a natural-language remote-task request. */
export function computerMentionInstruction(target: ComputerTarget) {
  return instruction(target, CURRENT_START(target));
}

/** The instruction sent before Connect could list remote-session create as its own tool. */
export function searchFirstComputerMentionInstruction(target: ComputerTarget) {
  return instruction(target, SEARCH_FIRST_START(target));
}
