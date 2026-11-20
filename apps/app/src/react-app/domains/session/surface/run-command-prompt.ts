export function runCommandPrompt(command: string): string {
  const longestFence = Math.max(0, ...Array.from(command.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `Run this command, then continue from its output:\n\n${fence}bash\n${command}\n${fence}`;
}
