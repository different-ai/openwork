import type { ScreenshotArtifact } from "@openwork/test-evidence";

/** Transient product chrome that must never ship in a docs screenshot. */
export const DEFAULT_NEVER = [
  "new notifications",
  "opencode_unconfigured",
  "OpenCode base URL",
  "Loading commands",
  "Pulling in the latest messages",
  "Checking workspace access",
] as const;

export type Gate = (artifact: ScreenshotArtifact) => boolean;

export interface GateOptions {
  expect: readonly string[];
  never?: readonly string[];
  route?: RegExp;
}

/** Build a side-effect-free acceptance predicate over a captured artifact. */
export function gate(options: GateOptions): Gate {
  const never = [...DEFAULT_NEVER, ...(options.never ?? [])];
  return (artifact) => {
    if (!options.expect.every((text) => artifact.visibleText.includes(text))) return false;
    if (never.some((text) => artifact.visibleText.includes(text))) return false;
    if (!options.route) return true;
    try {
      return options.route.test(decodeURIComponent(artifact.route));
    } catch {
      return false;
    }
  };
}
