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
