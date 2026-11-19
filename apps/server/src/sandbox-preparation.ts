import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { sandboxErrorCode } from "@openwork/sandbox";
import { SandboxFolderError } from "./sandbox-mounts.js";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";

export type SandboxStepId = "download" | "start" | "folders";
export type SandboxFailureCode = "unsupported_platform" | "virtualization_unavailable" | "image_failed" | "start_failed" | "folders_failed" | "timed_out" | "unavailable";
type Failure = { code: SandboxFailureCode; message: string; action: string | null; retryable: boolean };
export type SandboxStatusResponse = {
  mode: "off" | "use" | "force";
  state: "off" | "idle" | "preparing" | "ready" | "failed" | "unsupported";
  steps: { id: SandboxStepId; state: "waiting" | "active" | "done"; completedBytes?: number; totalBytes?: number }[];
  imageSource: "bundled" | "download";
  imageBytes: number | null;
  estimatedRemainingMs: number | null;
  startedAt: number | null;
  readyAt: number | null;
  lastPrepareMs: number | null;
  folders: { path: string; access: "rw" | "ro"; kind: "workspace" | "folder" }[];
  error: Failure | null;
};

export function sandboxStatus(mode: SandboxStatusResponse["mode"], imageSource: SandboxStatusResponse["imageSource"]): SandboxStatusResponse {
  return {
    mode, state: mode === "off" ? "off" : "idle", imageSource, imageBytes: null,
    estimatedRemainingMs: null, startedAt: null, readyAt: null, lastPrepareMs: null,
    steps: [{ id: "download", state: "waiting" }, { id: "start", state: "waiting" }, { id: "folders", state: "waiting" }], folders: [], error: null,
  };
}

export class SandboxPreparationError extends Error {
  constructor(readonly detail: Failure) {
    super(detail.message);
  }
}

const timedOut: Failure = { code: "timed_out", message: "The sandbox took too long to get ready. Nothing ran.", action: "Try again.", retryable: true };
export const sandboxPreparationTimeout = () => new SandboxPreparationError(timedOut);

function virtualizationUnavailable() {
  return new SandboxPreparationError({ code: "virtualization_unavailable", message: "This computer can't start the sandbox.", action: process.platform === "linux" ? "Ask your administrator to enable virtualization and give OpenWork access to it." : "Install the latest version of OpenWork and check that virtualization is available.", retryable: false });
}

export async function checkSandboxPlatform() {
  if (process.platform === "darwin" && process.arch !== "arm64") {
    throw new SandboxPreparationError({ code: "unsupported_platform", message: "This Mac can't run the sandbox.", action: "Use a version of OpenWork made for a Mac with Apple silicon.", retryable: false });
  }
  if (!(["darwin", "linux"].includes(process.platform) && ["arm64", "x64"].includes(process.arch))) {
    throw new SandboxPreparationError({ code: "unsupported_platform", message: "The sandbox isn't available on this computer.", action: "Use a Mac with Apple silicon or a Linux computer with virtualization enabled.", retryable: false });
  }
  if (process.platform === "linux") {
    await access("/dev/kvm", constants.R_OK | constants.W_OK).catch(() => { throw virtualizationUnavailable(); });
  }
}

export function sandboxFailure(error: unknown, step?: SandboxStepId): SandboxPreparationError {
  if (error instanceof SandboxPreparationError) return error;
  if (sandboxErrorCode(error) === "timeout") return sandboxPreparationTimeout();
  const cause = error instanceof Error ? error.cause : undefined;
  const code = isRecord(cause) ? cause.code : undefined;
  const text = error instanceof Error ? error.message : "";
  if (error instanceof SandboxFolderError || step === "folders") {
    return new SandboxPreparationError({ code: "folders_failed", message: error instanceof SandboxFolderError ? error.message : "The sandbox couldn't connect to your folders.", action: "Make sure the folders are still available, then try again.", retryable: true });
  }
  if (typeof code === "string" && ["runtimeNotInstalled", "runtimeIncomplete", "libkrunfwNotFound", "unsupported"].includes(code)
    || /(?:KVM|hypervisor|virtualization|entitlement|libkrunfw|mach-o)/i.test(text)) return virtualizationUnavailable();
  if (step === "download") return new SandboxPreparationError({ code: "image_failed", message: "The sandbox couldn't prepare its files.", action: "Check your connection or reinstall OpenWork, then try again.", retryable: true });
  if (step === "start") return new SandboxPreparationError({ code: "start_failed", message: "The sandbox couldn't start. Nothing ran.", action: "Try again.", retryable: true });
  return new SandboxPreparationError({ code: "unavailable", message: "The sandbox isn't available right now. Nothing ran.", action: "Try again.", retryable: true });
}

const duration = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export const sandboxPreparationDurations = createWorkspaceKvStore<{ cold: number | null; warm: number | null }>({
  tableName: "runtime_sandbox_preparation", valueColumn: "durations_json",
  parse(json) {
    const value: unknown = JSON.parse(json);
    return { cold: isRecord(value) ? duration(value.cold) : null, warm: isRecord(value) ? duration(value.warm) : null };
  },
  serialize: value => JSON.stringify(value),
});
