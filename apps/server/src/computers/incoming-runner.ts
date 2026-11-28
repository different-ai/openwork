import { setTimeout as delay } from "node:timers/promises";
import { computerActionForToolCall, insideSharedFolder, refusal } from "@openwork/computers";
import type { ComputerSharingSettings } from "@openwork/types/computer-sharing";
import {
  COMPUTER_OUTPUT_MAX_BYTES, computerCommandClaimResponseSchema, computerCommandListResponseSchema, computerToolCallSchema,
  type ComputerCommandAssignment, type ComputerCommandCompleteRequest, type ComputerRefusalCode,
} from "@openwork/types/den/computers";
import { externalFetch } from "../server-fetch.js";
import { SandboxToolError } from "../sandbox-tool-host.js";
import { IncomingSandboxUnavailable, type createIncomingSandbox } from "./incoming-sandbox.js";
import { createRunnerDen, RunnerDenError } from "./runner-den.js";
import type { RunnerCredential } from "./runner-credential.js";

export const RUNNER_FEATURE_RECHECK_MS = 300_000;
export const RUNNER_CAPABILITY_RECHECK_MS = 30_000;
export const runnerBackoff = (attempt: number) => Math.round(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) * (0.5 + Math.random() * 0.5));

function failed(code: string, message: string): ComputerCommandCompleteRequest {
  return { status: "failed", error: { code, message: message.slice(0, 300) } };
}
function refused(code: ComputerRefusalCode): ComputerCommandCompleteRequest {
  return { status: "refused", code, layer: refusal(code, { label: "This computer" }).layer };
}
function samePaths(left: string[], right: string[]) {
  return left.length === right.length && left.every(path => right.includes(path));
}
function assignmentCall(assignment: ComputerCommandAssignment) {
  if (assignment.call) return assignment.call;
  if (assignment.action.type !== "shell") return;
  const { command, cwd, timeoutMs } = assignment.action;
  return computerToolCallSchema.safeParse({ tool: "shell", input: { command, cwd: cwd ?? assignment.scope.folders[0], timeoutMs } }).data;
}

export async function runIncomingAssignment(assignment: ComputerCommandAssignment, settings: ComputerSharingSettings, sandbox: Pick<ReturnType<typeof createIncomingSandbox>, "run">, signal: AbortSignal): Promise<ComputerCommandCompleteRequest> {
  if (!settings.enabled) return refused("computer_not_allowed");
  if (!settings.sources.some(source => source.kind === "workbot" ? assignment.source.provider === "workbot" : source.id === assignment.source.id)) return refused("source_not_allowed");
  const { folders, writableFolders = [] } = assignment.scope;
  const shared = settings.folders.map(folder => folder.path);
  const editable = settings.folders.filter(folder => folder.access === "edit").map(folder => folder.path);
  if (!folders.length || !samePaths(folders, shared)) return refused("folder_not_shared");
  if (!samePaths(writableFolders, editable)) return refused("folder_read_only");
  const call = assignmentCall(assignment);
  if (!call) return failed("unsupported_request", "This computer can't run that request. Nothing ran.");
  const action = computerActionForToolCall(call);
  const path = call.tool === "shell" ? call.input.cwd : call.input.path;
  if (!insideSharedFolder(path, shared)) return refused("folder_not_shared");
  if (action.type === "write" && !insideSharedFolder(path, editable)) return refused("folder_read_only");
  const remaining = Date.parse(assignment.expiresAt) - Date.now();
  if (remaining <= 0) return failed("request_expired", "The request expired before the sandbox could run it. Nothing ran.");
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.min(remaining, 2_147_483_647))]);
  try {
    deadline.throwIfAborted();
    const result = await sandbox.run(call, settings.folders, deadline);
    const bytes = Buffer.from(result.content.map(part => part.text).join("\n"));
    const tooLong = bytes.length > COMPUTER_OUTPUT_MAX_BYTES;
    const output = tooLong ? new TextDecoder().decode(bytes.subarray(0, COMPUTER_OUTPUT_MAX_BYTES - 3)) : bytes.toString();
    return { status: "done", exitCode: result.metadata.exitCode ?? 0, output, truncated: result.metadata.truncated || tooLong };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof IncomingSandboxUnavailable) return failed("sandbox_unavailable", error.message.includes("Nothing ran.") ? error.message : `${error.message} Nothing ran.`);
    if ((call.tool === "write" || call.tool === "edit") && error instanceof Error && /read-only file system|\bEROFS\b/i.test(error.message)) {
      return failed("read_only", "That folder is shared read-only on this computer. Nothing was changed.");
    }
    if (error instanceof SandboxToolError) return failed("tool_failed", error.message);
    return failed("sandbox_operation_failed", "The sandbox couldn't finish the operation; check the file or folder before trying it again.");
  }
}

export function createIncomingRunner(deps: {
  sandbox: Pick<ReturnType<typeof createIncomingSandbox>, "run" | "stop">;
  settings(): Promise<ComputerSharingSettings>;
  available(): Promise<boolean>;
  rejected(credential: RunnerCredential): void;
  featureOff(credential: RunnerCredential): void;
  fetch?: typeof externalFetch;
  pause?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const pause = deps.pause ?? ((ms, signal) => delay(ms, undefined, { signal, ref: false }));
  let running = Promise.resolve();
  let controller: AbortController | undefined;
  let closed = false;
  async function loop(credential: RunnerCredential, signal: AbortSignal) {
    const request = createRunnerDen(credential, deps.fetch);
    let failures = 0;
    while (!signal.aborted) {
      try {
        if (!(await deps.settings()).enabled) return;
        if (!await deps.available()) { await pause(RUNNER_CAPABILITY_RECHECK_MS, signal); continue; }
        const items = computerCommandListResponseSchema.parse(await request("/v1/computer-runners/commands?waitMs=25000", signal, { timeoutMs: 30_000 })).items;
        for (const item of items) {
          signal.throwIfAborted();
          if (!await deps.available()) break;
          const path = `/v1/computer-commands/${encodeURIComponent(item.id)}`;
          try {
            const { assignment } = computerCommandClaimResponseSchema.parse(await request(`${path}/claim`, signal, { method: "POST" }));
            if (assignment.id !== item.id) throw new Error("Unexpected assignment");
            const result = await runIncomingAssignment(assignment, await deps.settings(), deps.sandbox, signal);
            await request(`${path}/complete`, signal, { method: "POST", body: result });
          } catch (error) {
            if (!(error instanceof RunnerDenError && error.commandGone)) throw error;
          }
        }
        failures = 0;
        if (!items.length) await pause(250, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof RunnerDenError) {
          if (error.credentialRejected) { deps.rejected(credential); return; }
          if (error.featureOff) {
            deps.featureOff(credential);
            await pause(RUNNER_FEATURE_RECHECK_MS, signal);
            continue;
          }
          if (error.capabilityRequired) { await pause(RUNNER_CAPABILITY_RECHECK_MS, signal); continue; }
        }
        await pause(runnerBackoff(failures++), signal);
      }
    }
  }
  return {
    update(credential: RunnerCredential | null) {
      if (closed) return;
      controller?.abort();
      const cleanup = deps.sandbox.stop().catch(() => undefined);
      if (!credential) { controller = undefined; return; }
      const signal = (controller = new AbortController()).signal;
      running = running.then(async () => { await cleanup; await loop(credential, signal); }).catch(() => undefined);
    },
    close() { closed = true; controller?.abort(); },
  };
}
