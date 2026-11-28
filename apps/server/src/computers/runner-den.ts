import { z } from "zod";
import { externalFetch } from "../server-fetch.js";
import type { RunnerCredential } from "./runner-credential.js";

const failure = z.object({ code: z.string().optional(), error: z.union([z.string(), z.object({ code: z.string().optional() })]).optional() });
export class RunnerDenError extends Error {
  constructor(readonly status: number, readonly code: string | undefined) { super("The organization couldn't complete the request."); }
  get featureOff() { return this.status === 404 && this.code === "feature_disabled"; }
  get capabilityRequired() { return this.status === 403 && this.code === "runner_capability_required"; }
  get credentialRejected() { return this.status === 401 || this.status === 403 && !this.capabilityRequired; }
  get commandGone() { return this.status === 409 || this.status === 404 && this.code === "command_not_found"; }
}
export function createRunnerDen(credential: RunnerCredential, fetch = externalFetch) {
  return async (path: string, signal: AbortSignal, { method = "GET", body, timeoutMs = 5_000 }: { method?: "GET" | "POST" | "PUT"; body?: object; timeoutMs?: number } = {}) => {
    signal.throwIfAborted();
    const response = await fetch(`${credential.baseUrl}${path}`, {
      method, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      headers: { Accept: "application/json", Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (response.ok) return payload;
    const error = failure.safeParse(payload).data;
    const code = error?.code ?? (typeof error?.error === "string" ? error.error : error?.error?.code);
    throw new RunnerDenError(response.status, code);
  };
}