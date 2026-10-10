import { join, isAbsolute } from "node:path";
import type { Platform } from "../contract/index.js";
export interface HostPlatform {
  platform: Platform;
  architecture: string;
  directories: { state: string; config: string };
  discover(): Promise<{ origin: string; token: string }>;
  tailscaleCandidates: string[];
}
export function platformDirectories(
  platform: Platform,
  home: string,
  env: Record<string, string | undefined>,
) {
  if (platform === "macos") {
    const d = join(home, "Library", "Application Support", "OpenWorkRemote");
    return { state: d, config: d };
  }
  const resolve = (v: string | undefined, fallback: string) =>
    v && isAbsolute(v) ? v : fallback;
  return {
    state: join(
      resolve(env.XDG_STATE_HOME, join(home, ".local", "state")),
      "openwork-remote",
    ),
    config: join(
      resolve(env.XDG_CONFIG_HOME, join(home, ".config")),
      "openwork-remote",
    ),
  };
}
