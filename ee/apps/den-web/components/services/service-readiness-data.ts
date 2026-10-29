import {
  deploymentServiceReadinessSchema,
  serviceIdSchema,
  SERVICE_STATE_LABELS,
  type DeploymentServiceReadiness,
  type DeploymentServiceStatus,
  type ServiceReadinessReason,
} from "@openwork/types/den/service-readiness";

export const CHECK_COOLDOWN_MS = 30_000;
export const CHECK_POLL_MS = 2_000;
export const CHECK_MAX_POLLS = 15;
export const SERVICES_VERIFY_ERROR = "Couldn't verify services. The last known results are kept. Try Check now again shortly.";
export const SERVICE_STALE_LABEL = "Out of date";

/** Reasons that come from a live check that succeeded; configuration alone never counts. */
const VERIFIED_REASONS: ReadonlySet<ServiceReadinessReason> = new Set([
  "health_verified", "database_verified", "email_verified", "email_key_verified",
]);

export function parseServicesSnapshot(payload: unknown): DeploymentServiceReadiness | null {
  const parsed = deploymentServiceReadinessSchema.safeParse(payload);
  if (!parsed.success || new Set(parsed.data.services.map((service) => service.id)).size !== parsed.data.services.length) return null;
  return parsed.data;
}

/** Missing rows are explicitly unknown, including the first snapshot from a new server. */
export function serviceRows(snapshot: DeploymentServiceReadiness | null): DeploymentServiceStatus[] {
  return serviceIdSchema.options.map((id) => snapshot?.services.find((service) => service.id === id) ?? {
    id, required: id === "database", configured: false, state: "unknown", reason: "not_checked",
    missingSettings: [], dependencies: [], notes: [], durationMs: null, checkedAt: null, lastSuccessAt: null, stale: false,
  });
}

/** Ready only when a live check succeeded; a stale or configuration-only result never reads as Ready. */
export function serviceDisplayState(service: DeploymentServiceStatus): DeploymentServiceStatus["state"] | "stale" {
  if (service.stale) return "stale";
  if (service.state === "ready" && (!service.checkedAt || !service.lastSuccessAt || !VERIFIED_REASONS.has(service.reason))) return "unknown";
  return service.state;
}

export function serviceStateLabel(service: DeploymentServiceStatus): string {
  const state = serviceDisplayState(service);
  return state === "stale" ? SERVICE_STALE_LABEL : SERVICE_STATE_LABELS[state];
}

export type ServicesFailure = { status: "signed-out" | "forbidden" | "error"; message: string };
export function servicesFailure(status?: number): ServicesFailure {
  if (status === 401) return { status: "signed-out", message: "Sign in again to check deployment services." };
  if (status === 403) return { status: "forbidden", message: "Service checks require access from your installation operator." };
  if (status === 429) return { status: "error", message: "Service checks are cooling down. Wait a moment, then choose Check now." };
  return { status: "error", message: SERVICES_VERIFY_ERROR };
}

export type ServicesRunResult = { status: "ready" } | ServicesFailure;
export type ServicesViewState = {
  status: "checking" | ServicesRunResult["status"];
  snapshot: DeploymentServiceReadiness | null;
  pending: boolean;
  message?: string;
};

export function finishServicesRun(snapshot: DeploymentServiceReadiness | null, result: ServicesRunResult): ServicesViewState {
  return {
    status: result.status, pending: false,
    snapshot: result.status === "signed-out" || result.status === "forbidden" ? null : snapshot,
    message: result.status === "ready" ? undefined : result.message,
  };
}

export type ServicesSnapshotResult =
  | { access: "ready"; data: DeploymentServiceReadiness }
  | { access: "signed-out" | "forbidden" | "error"; message: string; status?: number; code?: string; retryAfterSeconds?: number };

export type ServicesTransport = {
  getSnapshot: (signal: AbortSignal) => Promise<ServicesSnapshotResult>;
  startCheck: (signal: AbortSignal) => Promise<ServicesSnapshotResult>;
};

/** Poll cached server facts only, with an abort boundary before every request. */
export async function runServicesReadiness(options: {
  signal: AbortSignal;
  check: boolean;
  getSnapshot: () => Promise<ServicesSnapshotResult>;
  startCheck: () => Promise<ServicesSnapshotResult>;
  wait: () => Promise<void>;
  onSnapshot: (snapshot: DeploymentServiceReadiness) => void;
}): Promise<ServicesRunResult> {
  const { signal } = options;
  signal.throwIfAborted();
  let result = await (options.check ? options.startCheck() : options.getSnapshot());
  for (let polls = 0; ; polls += 1) {
    signal.throwIfAborted();
    if (result.access !== "ready") {
      return servicesFailure(result.access === "signed-out" ? 401 : result.access === "forbidden" ? 403 : result.status);
    }
    options.onSnapshot(result.data);
    if (!result.data.checking) return { status: "ready" };
    if (polls >= CHECK_MAX_POLLS) return { status: "error", message: "The service check is still running. Choose Check now shortly to read its latest result." };
    await options.wait();
    signal.throwIfAborted();
    result = await options.getSnapshot();
  }
}

export function waitForServicePoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, CHECK_POLL_MS);
    signal.addEventListener("abort", abort, { once: true });
  });
}
