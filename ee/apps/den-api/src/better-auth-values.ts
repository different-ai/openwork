// Defensive readers for the untyped bodies, params and rows Better Auth hands
// to hooks. Shared by auth.ts and the Core hook contributors it dispatches to.

export function maybeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry: unknown): entry is string => typeof entry === "string")
    : []
}

export function readStringProperty(value: unknown, propertyName: string) {
  if (!value || typeof value !== "object") {
    return null
  }

  const property = Object.getOwnPropertyDescriptor(value, propertyName)?.value
  return typeof property === "string" && property.trim() ? property.trim() : null
}
