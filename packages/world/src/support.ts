import { readFile } from "node:fs/promises";
import { formatTarget, hostOs, isWorldOs, isWorldProvider, providerOses, type WorldTarget } from "./target.ts";

/**
 * Static, literal `export const supportedTargets = ["..."]` declarations in
 * world scripts. Reading the literal (not importing the script) makes discovery
 * safe even when a world imports native desktop or provisioning modules.
 * Undeclared scripts can run locally for compatibility, but cannot request
 * a remote provider: an absent declaration is never evidence of support.
 */
export type WorldSupport = readonly string[] | undefined;

const DECLARATION = /\bexport\s+const\s+supportedTargets\s*=\s*(\[[^\]]*\])/;

export async function readWorldSupport(path: string): Promise<WorldSupport> {
  const text = await readFile(path, "utf8");
  const match = DECLARATION.exec(text);
  if (!match) return undefined;
  let value: unknown;
  try { value = JSON.parse(match[1] ?? ""); } catch { throw new Error(`Invalid supportedTargets declaration in ${path}: use a literal JSON string array.`); }
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    throw new Error(`Invalid supportedTargets declaration in ${path}: use a literal JSON string array.`);
  }
  for (const item of value) {
    const [provider, os, extra] = item.split("/");
    if (!provider || extra || (os !== undefined && os !== "host" && os !== "linux" && os !== "macos" && os !== "windows")) {
      throw new Error(`Invalid world target ${JSON.stringify(item)} in ${path}.`);
    }
    // A local declaration may name another host OS; discovery runs on many
    // developer machines. Only remote providers have a fixed OS catalog.
    if (!isWorldProvider(provider) || !os || (!isWorldOs(os) && os !== "host")
      || (os === "host" && provider !== "local")
      || (provider !== "local" && !providerOses(provider).includes(os === "host" ? hostOs() : os))) {
      throw new Error(`Invalid world target ${JSON.stringify(item)} in ${path}.`);
    }
  }
  return value;
}

function targetMatches(entry: string, target: WorldTarget): boolean {
  const [provider, os] = entry.split("/");
  return provider === target.provider && (os === "host" ? target.os === hostOs() : os === target.os);
}

export function assertWorldSupport(name: string, support: WorldSupport, target: WorldTarget): void {
  if (support === undefined) {
    if (target.provider === "local") return;
    throw new Error(`World ${name} has no supportedTargets declaration; cannot run on ${formatTarget(target)}. Declare a verified target in the script first.`);
  }
  if (support.some((entry) => targetMatches(entry, target))) return;
  throw new Error(`World ${name} cannot run on ${formatTarget(target)}. Supported: ${support.join(", ") || "none"}.`);
}

export function supportedTargetDescription(support: WorldSupport): string {
  return support?.join(", ") ?? "local only (not declared)";
}
