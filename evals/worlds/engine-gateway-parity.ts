import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { allocateFreePort } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";
import { readAvailableModels, selectModel, signInDesktopAs, waitUntilInteractive } from "@openwork/behaviors";
import { engineParity } from "./engine-parity.ts";
import { readDefaultDesktopPolicy } from "./desktop-policies.ts";

export function parityRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a response object");
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty response string");
  return value;
}

