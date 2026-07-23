import {
  CONNECT_DIAGNOSTIC_CLIENT_RETENTION_MS,
  CONNECT_DIAGNOSTIC_NETWORK_CODES,
  CONNECT_DIAGNOSTIC_PHASES,
  connectDiagnosticClientEventSchema,
  type ConnectDiagnosticClientEvent,
  type ConnectDiagnosticNetworkCode,
  type ConnectDiagnosticPhase,
} from "@openwork/types/den/connect-diagnostics";

import { recordInspectorEvent } from "@/app/lib/app-inspector";
import { createDenClient, readDenSettings, type DenSettings } from "@/app/lib/den";
import type {
  OpenworkCloudMcpFailure,
  OpenworkCloudMcpHealth,
} from "@/app/lib/openwork-server";

import {
  CONNECT_DIAGNOSTIC_FAILURE_STATE_KEY,
  CONNECT_DIAGNOSTIC_QUEUE_KEY,
  clearConnectDiagnosticLocalData,
  getConnectDiagnosticsClientId,
  isConnectDiagnosticsEnabled,
} from "./connect-diagnostics-preferences";

const CONNECT_DIAGNOSTIC_QUEUE_LIMIT = 500;
const APP_VERSION = String(import.meta.env.VITE_OPENWORK_APP_VERSION ?? "").trim();

type QueuedConnectDiagnostic = {
  queuedAt: number;
  denBaseUrl: string;
  organizationId: string;
  event: ConnectDiagnosticClientEvent;
};

type FailureState = Record<string, number>;
const flushInFlight = new Map<string, Promise<number>>();

export type ConnectDiagnosticAttempt = {
  outcome: "ready" | "skipped" | "failed";
  health: OpenworkCloudMcpHealth | null;
  issue?: Pick<
    OpenworkCloudMcpFailure,
    "code" | "stage" | "retryable" | "requestId" | "referenceId" | "details"
  > | null;
  maintenanceAttempt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTarget(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function targetKey(settings: Pick<DenSettings, "baseUrl" | "activeOrgId">): string {
  return JSON.stringify([normalizeTarget(settings.baseUrl), settings.activeOrgId?.trim() ?? ""]);
}

function parseQueueItem(value: unknown): QueuedConnectDiagnostic | null {
  if (!isRecord(value)) return null;
  const queuedAt = typeof value.queuedAt === "number" && Number.isFinite(value.queuedAt)
    ? value.queuedAt
    : null;
  const denBaseUrl = typeof value.denBaseUrl === "string" ? normalizeTarget(value.denBaseUrl) : "";
  const organizationId = typeof value.organizationId === "string" ? value.organizationId.trim() : "";
  const event = connectDiagnosticClientEventSchema.safeParse(value.event);
  if (queuedAt === null || !denBaseUrl || !organizationId || !event.success) return null;
  return { queuedAt, denBaseUrl, organizationId, event: event.data };
}

function readQueue(now = Date.now()): QueuedConnectDiagnostic[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CONNECT_DIAGNOSTIC_QUEUE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(parseQueueItem)
      .filter((item): item is QueuedConnectDiagnostic =>
        item !== null && now - item.queuedAt <= CONNECT_DIAGNOSTIC_CLIENT_RETENTION_MS)
      .slice(-CONNECT_DIAGNOSTIC_QUEUE_LIMIT);
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedConnectDiagnostic[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CONNECT_DIAGNOSTIC_QUEUE_KEY,
      JSON.stringify(queue.slice(-CONNECT_DIAGNOSTIC_QUEUE_LIMIT)),
    );
  } catch {
    // Best effort. Diagnostics must never interfere with Connect itself.
  }
}

function readFailureState(): FailureState {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(CONNECT_DIAGNOSTIC_FAILURE_STATE_KEY) ?? "{}",
    ) as unknown;
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isInteger(entry[1]) && entry[1] >= 0)
        .map(([key, value]) => [key, Math.min(value, 10_000)]),
    );
  } catch {
    return {};
  }
}

function writeFailureState(state: FailureState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONNECT_DIAGNOSTIC_FAILURE_STATE_KEY, JSON.stringify(state));
  } catch {
    // Best effort.
  }
}

function safePhase(stage: string | null | undefined): ConnectDiagnosticPhase {
  return CONNECT_DIAGNOSTIC_PHASES.includes(stage as ConnectDiagnosticPhase)
    ? stage as ConnectDiagnosticPhase
    : "engine_delivery";
}

function safeErrorCode(code: string | null | undefined): string | null {
  const value = code?.trim() ?? "";
  if (!value) return null;
  return value.length <= 120 && /^[a-z0-9][a-z0-9_.-]*$/iu.test(value)
    ? value
    : "connect_failure";
}

function safeRequestId(issue: ConnectDiagnosticAttempt["issue"]): string | null {
  const value = issue?.requestId?.trim() || issue?.referenceId?.trim() || "";
  return /^[a-z0-9][a-z0-9_.:-]{0,127}$/iu.test(value) ? value : null;
}

function walkDiagnosticMetadata(
  value: unknown,
  visit: (record: Record<string, unknown>) => string | number | null,
  seen = new Set<unknown>(),
): string | number | null {
  if (!isRecord(value) || seen.has(value)) return null;
  seen.add(value);
  const direct = visit(value);
  if (direct !== null) return direct;
  for (const nested of Object.values(value)) {
    if (isRecord(nested)) {
      const found = walkDiagnosticMetadata(nested, visit, seen);
      if (found !== null) return found;
    }
  }
  return null;
}

function networkCodeFrom(value: unknown): ConnectDiagnosticNetworkCode | null {
  const allowed = new Set<string>(CONNECT_DIAGNOSTIC_NETWORK_CODES);
  const found = walkDiagnosticMetadata(value, (record) => {
    for (const key of ["code", "networkCode", "cause"]) {
      const candidate = typeof record[key] === "string" ? record[key].trim().toUpperCase() : "";
      if (allowed.has(candidate)) return candidate;
    }
    const message = typeof record.message === "string"
      ? record.message.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")
      : "";
    for (const candidate of CONNECT_DIAGNOSTIC_NETWORK_CODES) {
      if (message.includes(candidate)) return candidate;
    }
    return null;
  });
  return typeof found === "string" ? found as ConnectDiagnosticNetworkCode : null;
}

function httpStatusFrom(value: unknown): number | null {
  const found = walkDiagnosticMetadata(value, (record) => {
    for (const key of ["httpStatus", "status", "statusCode"]) {
      const candidate = record[key];
      if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) {
        return candidate;
      }
    }
    return null;
  });
  return typeof found === "number" ? found : null;
}

function failedProbeStep(health: OpenworkCloudMcpHealth | null) {
  return health?.tools.direct.trace?.steps.find((step) => !step.ok) ?? null;
}

function compatibilityVersion(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  const bounded = normalized.slice(0, 80);
  return /^[a-z0-9][a-z0-9.+_() -]{0,79}$/iu.test(bounded) ? bounded : null;
}

function platformCategory(): "macos" | "windows" | "linux" | "other" | null {
  if (typeof navigator === "undefined") return null;
  const platform = navigator.platform?.toLowerCase() ?? "";
  if (platform.includes("mac")) return "macos";
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux")) return "linux";
  return "other";
}

function createEvent(
  input: ConnectDiagnosticAttempt,
  settings: DenSettings,
  clientId: string,
): ConnectDiagnosticClientEvent | null {
  if (input.outcome === "skipped") return null;
  const failures = readFailureState();
  const key = targetKey(settings);
  const previousFailures = failures[key] ?? 0;
  const consecutiveFailures = input.outcome === "failed"
    ? Math.min(10_000, previousFailures + 1)
    : 0;
  failures[key] = consecutiveFailures;
  writeFailureState(failures);

  // Healthy maintenance is noise. Preserve only the transition that proves a
  // previously failing client recovered.
  if (input.outcome === "ready" && previousFailures === 0) return null;

  const probeStep = failedProbeStep(input.health);
  const diagnosticDetails = input.issue?.details
    ?? input.health?.firstFailure?.details
    ?? probeStep?.error
    ?? input.health?.tools.direct.error;
  return connectDiagnosticClientEventSchema.parse({
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    clientId,
    observedAt: new Date().toISOString(),
    phase: input.outcome === "failed"
      ? safePhase(input.issue?.stage ?? input.health?.firstFailure?.stage)
      : "mcp_request",
    outcome: input.outcome === "failed" ? "failure" : "recovered",
    errorCode: input.outcome === "failed"
      ? safeErrorCode(input.issue?.code ?? input.health?.firstFailure?.code)
      : null,
    networkCode: input.outcome === "failed" ? networkCodeFrom(diagnosticDetails) : null,
    httpStatus: input.outcome === "failed"
      ? probeStep?.httpStatus ?? httpStatusFrom(diagnosticDetails)
      : null,
    retryable: input.outcome === "failed" ? input.issue?.retryable ?? null : null,
    deviceOnline: typeof navigator === "undefined" || typeof navigator.onLine !== "boolean"
      ? null
      : navigator.onLine,
    durationMs: typeof input.health?.durationMs === "number"
      ? Math.max(0, Math.min(10 * 60 * 1_000, Math.round(input.health.durationMs)))
      : null,
    consecutiveFailures,
    maintenanceAttempt: Math.max(1, Math.min(20, Math.round(input.maintenanceAttempt))),
    appVersion: APP_VERSION || null,
    platform: platformCategory(),
    serverVersion: compatibilityVersion(input.health?.compatibility.openwork.serverVersion),
    engineVersion: compatibilityVersion(input.health?.compatibility.opencode.actualVersion),
    serverRequestId: input.outcome === "failed"
      ? safeRequestId(input.issue) ?? safeRequestId(input.health?.firstFailure)
      : null,
  });
}

async function flushConnectDiagnosticQueueOnce(settings: DenSettings): Promise<number> {
  if (!isConnectDiagnosticsEnabled()) {
    clearConnectDiagnosticLocalData();
    return 0;
  }
  const orgId = settings.activeOrgId?.trim() ?? "";
  const authToken = settings.authToken?.trim() ?? "";
  const denBaseUrl = normalizeTarget(settings.baseUrl);
  if (!orgId || !authToken || !denBaseUrl) return 0;

  const queue = readQueue();
  const deliverable = queue
    .filter((item) => item.denBaseUrl === denBaseUrl && item.organizationId === orgId)
    .slice(0, 50);
  if (deliverable.length === 0) {
    writeQueue(queue);
    return 0;
  }

  await createDenClient({ baseUrl: settings.baseUrl, token: authToken })
    .reportConnectDiagnosticIncidents(orgId, { events: deliverable.map((item) => item.event) });
  const delivered = new Set(deliverable.map((item) => item.event.eventId));
  // Re-read after the request so an event queued while delivery was in flight
  // is never overwritten by this older snapshot.
  writeQueue(readQueue().filter((item) => !delivered.has(item.event.eventId)));
  recordInspectorEvent("connect_diagnostics.delivered", { count: delivered.size });
  return delivered.size;
}

export function flushConnectDiagnosticQueue(settings = readDenSettings()): Promise<number> {
  const key = targetKey(settings);
  const existing = flushInFlight.get(key);
  if (existing) return existing;
  const pending = flushConnectDiagnosticQueueOnce(settings).finally(() => {
    if (flushInFlight.get(key) === pending) flushInFlight.delete(key);
  });
  flushInFlight.set(key, pending);
  return pending;
}

export function recordConnectDiagnosticAttempt(
  input: ConnectDiagnosticAttempt,
  settings = readDenSettings(),
): void {
  if (!isConnectDiagnosticsEnabled()) {
    clearConnectDiagnosticLocalData();
    return;
  }
  const clientId = getConnectDiagnosticsClientId();
  const orgId = settings.activeOrgId?.trim() ?? "";
  const denBaseUrl = normalizeTarget(settings.baseUrl);
  if (!clientId || !orgId || !settings.authToken?.trim() || !denBaseUrl) return;
  let event: ConnectDiagnosticClientEvent | null = null;
  try {
    event = createEvent(input, settings, clientId);
  } catch (error) {
    recordInspectorEvent("connect_diagnostics.event_rejected", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
  }
  if (event) {
    const queue = readQueue();
    queue.push({ queuedAt: Date.now(), denBaseUrl, organizationId: orgId, event });
    writeQueue(queue);
    recordInspectorEvent("connect_diagnostics.queued", {
      clientId,
      eventId: event.eventId,
      outcome: event.outcome,
      phase: event.phase,
      errorCode: event.errorCode,
    });
  }
  void flushConnectDiagnosticQueue(settings).catch((error: unknown) => {
    recordInspectorEvent("connect_diagnostics.delivery_failed", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
  });
}

export const connectDiagnosticsTesting = {
  readQueue,
  networkCodeFrom,
  httpStatusFrom,
};
