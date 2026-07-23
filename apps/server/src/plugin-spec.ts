/** Return the identity OpenCode uses for package-style plugin de-duplication. */
export function normalizePluginSpec(spec: string): string {
  const trimmed = spec.trim();
  if (
    trimmed.startsWith("file:")
    || trimmed.startsWith("http:")
    || trimmed.startsWith("https:")
    || trimmed.startsWith("git:")
  ) {
    return trimmed;
  }
  if (trimmed.startsWith("/")) return trimmed;
  if (trimmed.startsWith("@")) {
    const atIndex = trimmed.indexOf("@", 1);
    return atIndex > 0 ? trimmed.slice(0, atIndex) : trimmed;
  }
  const atIndex = trimmed.indexOf("@");
  return atIndex > 0 ? trimmed.slice(0, atIndex) : trimmed;
}
