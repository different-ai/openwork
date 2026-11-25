import { CliError } from "./io.ts"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

export function optionalText(value: unknown, key: string): string | null {
  const found = field(value, key)
  return typeof found === "string" && found !== "" ? found : null
}

export function text(value: unknown, key: string): string {
  return optionalText(value, key) ?? ""
}

export function requiredText(value: unknown, key: string): string {
  const found = optionalText(value, key)
  if (found === null) throw new CliError("unexpected_response", `The API's answer is missing "${key}".`, value)
  return found
}

export function count(value: unknown, key: string): number {
  const found = field(value, key)
  return typeof found === "number" ? found : 0
}

export function items(value: unknown, key: string): unknown[] {
  const found = field(value, key)
  return Array.isArray(found) ? found : []
}

export function strings(value: unknown, key: string): string[] {
  return items(value, key).filter((item) => typeof item === "string")
}
