import { existsSync } from "node:fs";
import path from "node:path";

export function opencodeTargetName(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "opencode-aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "opencode-x86_64-apple-darwin";
  if (platform === "linux" && arch === "arm64") return "opencode-aarch64-unknown-linux-gnu";
  if (platform === "linux" && arch === "x64") return "opencode-x86_64-unknown-linux-gnu";
  if (platform === "win32" && arch === "arm64") return "opencode-aarch64-pc-windows-msvc.exe";
  if (platform === "win32" && arch === "x64") return "opencode-x86_64-pc-windows-msvc.exe";
  return null;
}

export function resolveBundledOpencodeBinary({
  appRoot,
  resourcesPath,
  platform = process.platform,
  arch = process.arch,
  fileExists = existsSync,
}) {
  const alias = platform === "win32" ? "opencode.exe" : "opencode";
  const target = opencodeTargetName(platform, arch);
  const directories = [
    resourcesPath ? path.join(resourcesPath, "sidecars") : null,
    appRoot ? path.join(appRoot, "resources", "sidecars") : null,
  ].filter(Boolean);
  for (const directory of directories) {
    for (const fileName of [target, alias].filter(Boolean)) {
      const candidate = path.join(directory, fileName);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}
