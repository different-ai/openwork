export function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value)) : {};
}

export const readString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
