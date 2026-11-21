function fenced(command: string): string {
  const longestFence = Math.max(0, ...Array.from(command.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `${fence}bash\n${command}\n${fence}`;
}

export function runCommandPrompt(command: string): string {
  return `Run this command, then continue from its output:\n\n${fenced(command)}`;
}

export function ranCommandNote(command: string): string {
  return `I ran this command from a code block in this conversation. Its output is above. Continue from the result; do not run it again:\n\n${fenced(command)}`;
}

export const RAN_COMMAND_NOTE_SOURCE = "openwork-run-command";
