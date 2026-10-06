/**
 * Release-channel concept for OpenWork desktop builds.
 *
 * There are two channels users can opt into:
 *
 * - "stable": the default. The desktop app auto-updates from the rolling
 *   "latest" GitHub release attached to whichever semver tag most recently
 *   finished the Release App workflow. macOS, Linux, Windows.
 *
 * - "alpha": a macOS-only rolling channel that auto-updates on every merge
 *   to `dev`. Alpha builds are published to a fixed GitHub release tag
 *   (`alpha-macos-latest`) so the updater endpoint stays stable while the
 *   underlying artifact is replaced on every dev push.
 *
 * Only the macOS (arm64) build is published to the alpha channel today.
 * Linux and Windows always resolve to the stable channel.
 */

import type { ReleaseChannel } from "../types";

/** Stable channel's Tauri updater manifest URL. */
export const STABLE_UPDATER_ENDPOINT =
  "https://github.com/different-ai/openwork/releases/latest/download/latest.json";

/** Alpha channel's Tauri updater manifest URL (macOS-only, rolling). */
export const ALPHA_UPDATER_ENDPOINT =
  "https://github.com/different-ai/openwork/releases/download/alpha-macos-latest/latest.json";

export type PlatformKind = "darwin" | "linux" | "windows" | "web" | "unknown";

/**
 * Returns true when the given platform supports the alpha channel.
 *
 * Today alpha builds are produced only for macOS (arm64). The type-level
 * conservatism here is deliberate: it's easier to widen later than to
 * silently start advertising an alpha endpoint that serves no artifact.
 */
export function isAlphaChannelSupported(platform: PlatformKind): boolean {
  return platform === "darwin";
}

/** Narrow an arbitrary string to a valid ReleaseChannel, defaulting to stable. */
export function coerceReleaseChannel(value: unknown): ReleaseChannel {
  return value === "alpha" ? "alpha" : "stable";
}
