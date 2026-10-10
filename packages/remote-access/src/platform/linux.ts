import { homedir, arch } from "node:os";
import { join, isAbsolute } from "node:path";
import { platformDirectories, type HostPlatform } from "./types.js";
import { discoverDesktopAt } from "./desktop-discovery.js";
export function linuxPlatform(
  options: { home?: string; env?: Record<string, string | undefined> } = {},
): HostPlatform {
  const home = options.home ?? homedir(),
    env = options.env ?? process.env;
  const config =
    env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : join(home, ".config");
  return {
    platform: "linux",
    architecture: arch(),
    directories: platformDirectories("linux", home, env),
    tailscaleCandidates: ["/usr/bin/tailscale", "/usr/local/bin/tailscale"],
    discover: () => discoverDesktopAt(join(config, "com.differentai.openwork")),
  };
}
