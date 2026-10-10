import { homedir, arch } from "node:os";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { BridgeError } from "../contract/index.js";
import { platformDirectories, type HostPlatform } from "./types.js";
export function macosPlatform(): HostPlatform {
  const home = homedir();
  return {
    platform: "macos",
    architecture: arch(),
    directories: platformDirectories("macos", home, process.env),
    tailscaleCandidates: [
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/usr/local/bin/tailscale",
      "/opt/homebrew/bin/tailscale",
    ],
    async discover() {
      const root = join(
        home,
        "Library",
        "Application Support",
        "com.differentai.openwork",
      );
      const read = async (name: string) => {
        const f = join(root, name),
          s = await lstat(f);
        if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid?.())
          throw new BridgeError("UNTRUSTED_INSTALLATION");
        return JSON.parse(await readFile(f, "utf8"));
      };
      const state = await read("openwork-server-state.json");
      if (
        !Number.isInteger(state.preferredPort) ||
        state.preferredPort < 1 ||
        state.preferredPort > 65535
      )
        throw new BridgeError("UPSTREAM_UNAVAILABLE");
      const tokens = await read("openwork-server-tokens.json");
      if (
        typeof tokens.credentials?.clientToken !== "string" ||
        !tokens.credentials.clientToken
      )
        throw new BridgeError("UPSTREAM_UNAVAILABLE");
      return {
        origin: `http://127.0.0.1:${state.preferredPort}`,
        token: tokens.credentials.clientToken,
      };
    },
  };
}
