/**
 * Names an agent passed that the action does not declare, as an error that
 * lists the valid ones. Without it a wrong name (`sessionId` on a query that
 * only reads the current chat, `limit` for `count`) is ignored and the agent
 * gets a plausible but wrong answer. Actions that declare no `args` are left
 * alone, since nothing says what they accept.
 */
export function undeclaredArgsError(
  action: { id: string; args?: ReadonlyArray<{ name: string }> },
  args: unknown,
): string | null {
  if (!action.args || !args || typeof args !== "object" || Array.isArray(args)) return null;
  const declared = action.args.map((arg) => arg.name);
  const unknown = Object.keys(args).filter((key) => !declared.includes(key));
  if (!unknown.length) return null;
  const names = unknown.map((key) => JSON.stringify(key)).join(", ");
  const valid = declared.length ? `Valid arguments: ${declared.join(", ")}.` : "It takes no arguments.";
  return `Unknown argument${unknown.length === 1 ? "" : "s"} ${names} for ${action.id}. ${valid}`;
}
