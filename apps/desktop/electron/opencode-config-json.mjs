import { parse } from "jsonc-parser";

export function parseOpencodeConfig(raw) {
  const errors = [];
  const config = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Invalid OpenCode config JSON/JSONC.");
  }
  return config;
}
