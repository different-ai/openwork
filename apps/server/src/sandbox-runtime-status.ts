import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type SandboxRuntimeStatus = {
  state: "idle" | "starting" | "ready" | "unsupported" | "failed";
  stage?: "preparing_files" | "starting";
  progress?: { completed: number; total: number };
  reason?: "unsupported_platform" | "virtualization_unavailable" | "app_update_required" | "runtime_unavailable" | "runtime_permission_denied" | "runtime_failed" | "stopped";
  message?: string;
  canRetry: boolean;
};

export function sandboxPlatformStatus(platform: string, arch: string, virtualizationAvailable = true): SandboxRuntimeStatus | undefined {
  if (platform === "darwin" && arch !== "arm64") return { state: "unsupported", reason: "unsupported_platform", message: "This Mac does not support sandbox mode. Choose On this computer, or use an Apple silicon Mac.", canRetry: false };
  if ((platform !== "darwin" && platform !== "linux") || !["arm64", "x64"].includes(arch)) return { state: "unsupported", reason: "unsupported_platform", message: "Sandbox mode is not supported on this computer. Choose On this computer instead.", canRetry: false };
  if (platform === "linux" && !virtualizationAvailable) return { state: "unsupported", reason: "virtualization_unavailable", message: "This Linux computer cannot start a sandbox. Ask your administrator to enable virtualization, or choose On this computer.", canRetry: true };
}

const installationUnavailable: SandboxRuntimeStatus = { state: "unsupported", reason: "runtime_unavailable", message: "OpenWork cannot access its sandbox folder. Restore access or reinstall OpenWork, then try again.", canRetry: true };
const installationDenied: SandboxRuntimeStatus = { state: "unsupported", reason: "runtime_permission_denied", message: "OpenWork cannot access its sandbox files. Restore access or reinstall OpenWork, then try again.", canRetry: true };

/** Inspect real installation paths without creating files or invoking the runtime. */
export async function sandboxInstallationStatus(home = process.env.MSB_HOME || join(homedir(), ".microsandbox"), binary = process.env.MSB_PATH): Promise<SandboxRuntimeStatus | undefined> {
  let candidate = resolve(home);
  for (;;) {
    try {
      if (!(await stat(candidate)).isDirectory()) return installationUnavailable;
      await access(candidate, constants.R_OK | constants.W_OK | constants.X_OK);
      break;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT" && dirname(candidate) !== candidate) { candidate = dirname(candidate); continue; }
      return error instanceof Error && "code" in error && ["EACCES", "EPERM", "EROFS"].includes(String(error.code)) ? installationDenied : installationUnavailable;
    }
  }
  if (binary) {
    try {
      if (!(await stat(binary)).isFile()) return installationUnavailable;
      await access(binary, constants.R_OK | constants.X_OK);
    } catch (error) {
      return error instanceof Error && "code" in error && ["EACCES", "EPERM"].includes(String(error.code)) ? installationDenied : installationUnavailable;
    }
  }
}

export async function localSandboxSupport(): Promise<SandboxRuntimeStatus | undefined> {
  const platform = sandboxPlatformStatus(process.platform, process.arch);
  if (platform) return platform;
  if (process.platform === "linux") {
    const available = await access("/dev/kvm", constants.R_OK | constants.W_OK).then(() => true, () => false);
    const virtualization = sandboxPlatformStatus(process.platform, process.arch, available);
    if (virtualization) return virtualization;
  }
  return sandboxInstallationStatus();
}

/** Only stable error codes choose recovery copy. Native diagnostics never reach settings. */
export function sandboxRuntimeFailure(error: unknown, preparing = true): SandboxRuntimeStatus {
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = "code" in current ? current.code : undefined;
    if (["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED"].includes(String(code))) {
      return { state: "unsupported", reason: "app_update_required", message: "Sandbox files are unavailable. Update OpenWork, then try again.", canRetry: false };
    }
    if (["runtimeNotInstalled", "runtimeIncomplete", "libkrunfwNotFound", "imageNotFound"].includes(String(code)) || preparing && ["io", "database"].includes(String(code))) {
      return { state: "unsupported", reason: "runtime_unavailable", message: "OpenWork cannot start its sandbox files. Restore access or update OpenWork, then try again.", canRetry: true };
    }
    if (preparing && ["EACCES", "EPERM", "EROFS", "ENOEXEC"].includes(String(code))) {
      return { state: "unsupported", reason: "runtime_permission_denied", message: "OpenWork cannot access its sandbox files. Restore access or reinstall OpenWork, then try again.", canRetry: true };
    }
    if (code === "unsupported") return { state: "unsupported", reason: "runtime_unavailable", message: "This version of OpenWork cannot start a sandbox here. Update OpenWork, or choose On this computer.", canRetry: false };
    current = current.cause;
  }
  return { state: "failed", reason: "runtime_failed", message: preparing ? "The sandbox could not start. Try again to continue." : "The sandbox stopped. Try again to continue.", canRetry: true };
}
