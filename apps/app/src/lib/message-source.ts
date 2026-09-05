import type { UIMessage } from "ai";

// Attribution is display metadata, never a permission or identity claim.
function parseMessageSource(value: unknown) {
  if (typeof value !== "object" || value === null) return null;
  const kind: unknown = Reflect.get(value, "kind");
  if (kind !== "automation" && kind !== "task" && kind !== "remote-session") return null;
  const surface: unknown = Reflect.get(value, "surface");
  if (surface !== undefined && surface !== "desktop" && surface !== "cloud") return null;
  const name: unknown = Reflect.get(value, "name");
  if (name !== undefined && typeof name !== "string") return null;
  return { kind, ...(surface ? { surface } : {}), ...(typeof name === "string" ? { name: name.trim().slice(0, 200) } : {}) };
}

export function messageSourceMetadata(metadata: Record<string, unknown> | undefined) {
  const source = parseMessageSource(metadata?.openworkSource);
  return source ? { openworkSource: source } : {};
}

export function getMessageSourceLabel(message: UIMessage): string | null {
  if (message.role !== "user") return null;
  for (const part of message.parts) {
    if (part.type !== "text") continue;
    const source = parseMessageSource(part.providerMetadata?.opencode?.openworkSource);
    if (!source) continue;
    const label = source.kind === "automation" ? "From automation"
      : source.kind === "task" ? "From another task" : "From remote session";
    const surface = source.surface === "desktop" ? "Desktop" : source.surface === "cloud" ? "Cloud" : null;
    return [label, source.name, surface].filter(Boolean).join(" · ");
  }
  return null;
}
