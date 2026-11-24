import type { ReleaseChannel } from "../types";

export const STABLE_UPDATER_ENDPOINT =
  "https://github.com/different-ai/openwork/releases/latest/download/latest.json";

export const ALPHA_UPDATER_ENDPOINT =
  "https://github.com/different-ai/openwork/releases/download/alpha-macos-latest/latest.json";

export type PlatformKind = "darwin" | "linux" | "windows" | "web" | "unknown";

export function isAlphaChannelSupported(platform: PlatformKind): boolean {
  return platform === "darwin";
}

export function coerceReleaseChannel(value: unknown): ReleaseChannel {
  return value === "alpha" ? "alpha" : "stable";
}
