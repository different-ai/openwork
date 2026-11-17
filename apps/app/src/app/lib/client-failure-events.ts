import type { ClientFailureReport } from "@openwork/types/den/diagnostics";
import { desktopBridge } from "./desktop";
import { isDesktopRuntime } from "./runtime-env";

export type ClientFailureInput = Pick<ClientFailureReport, "component" | "phase" | "reason"> & Partial<Pick<ClientFailureReport, "httpStatus" | "exitCode">>;
export type DenFailureTarget = { baseUrl: string; token: string; organizationId: string };
type Listener = (failure: ClientFailureInput | null, target: DenFailureTarget) => void;
let listener: Listener | null = null;

export function subscribeClientFailures(next: Listener): () => void {
  listener = next;
  return () => { if (listener === next) listener = null; };
}
export function emitClientFailure(failure: ClientFailureInput | null, target: DenFailureTarget): void {
  try {
    if (failure && isDesktopRuntime()) void desktopBridge.clientFailuresRecord(failure, target).catch(() => undefined);
    listener?.(failure, target);
  } catch {}
}
