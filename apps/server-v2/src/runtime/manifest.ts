export type RuntimeTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "windows-arm64"
  | "windows-x64";

export type RuntimeAssetName = "opencode" | "opencode-router";
export type RuntimeAssetSource = "development" | "release";

export type RuntimeManifestFile = {
  path: string;
  sha256: string;
  size: number;
};

export type RuntimeManifest = {
  files: Record<RuntimeAssetName, RuntimeManifestFile>;
  generatedAt: string;
  manifestVersion: 1;
  opencodeVersion: string;
  rootDir: string;
  routerVersion: string;
  serverVersion: string;
  source: RuntimeAssetSource;
  target: RuntimeTarget;
};

export type ResolvedRuntimeBinary = {
  absolutePath: string;
  name: RuntimeAssetName;
  sha256: string;
  size: number;
  source: RuntimeAssetSource;
  stagedRoot: string;
  target: RuntimeTarget;
  version: string;
};

export type ResolvedRuntimeBundle = {
  manifest: RuntimeManifest;
  opencode: ResolvedRuntimeBinary;
  router: ResolvedRuntimeBinary;
};

export function resolveRuntimeTarget(): RuntimeTarget | null {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") {
      return "darwin-arm64";
    }
    if (process.arch === "x64") {
      return "darwin-x64";
    }
    return null;
  }

  if (process.platform === "linux") {
    if (process.arch === "arm64") {
      return "linux-arm64";
    }
    if (process.arch === "x64") {
      return "linux-x64";
    }
    return null;
  }

  if (process.platform === "win32") {
    if (process.arch === "arm64") {
      return "windows-arm64";
    }
    if (process.arch === "x64") {
      return "windows-x64";
    }
    return null;
  }

  return null;
}

export function runtimeBinaryFilename(name: RuntimeAssetName, target: RuntimeTarget) {
  const base = name === "opencode" ? "opencode" : "opencode-router";
  return target.startsWith("windows") ? `${base}.exe` : base;
}

export function resolveBunTarget(target: RuntimeTarget) {
  return `bun-${target}`;
}
