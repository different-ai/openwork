import { createJsonStdoutLogger } from "@openwork-ee/utils/observability";
import type { JsonObject, JsonStdoutLogger, StructuredLogLevel } from "@openwork-ee/utils/observability";

import { getDenWebServiceName } from "./server-config";
import { scrubLogFields, scrubText } from "./scrub";

export type StructuredLogSink = {
  log: (level: StructuredLogLevel, message: string, fields?: JsonObject) => void;
};

type RetainedTelemetrySdk = {
  shutdown: () => Promise<void>;
  forceFlush?: () => Promise<void>;
};

export type TelemetryShutdownSignal = "SIGTERM" | "SIGINT";

export type TelemetrySignalTarget = {
  on: (signal: TelemetryShutdownSignal, listener: () => void) => unknown;
};

type DenWebObservabilityState = {
  sink: StructuredLogSink;
  telemetrySdkStarted: boolean;
  retainedTelemetrySdk?: RetainedTelemetrySdk;
  telemetryShutdownHandlersRegistered?: boolean;
  telemetryShutdownPromise?: Promise<void>;
};

declare global {
  var __denWebObservabilityState: DenWebObservabilityState | undefined;
}

function jsonStdoutSink(): StructuredLogSink {
  const logger = createJsonStdoutLogger({ serviceName: getDenWebServiceName(process.env) });
  return { log: logger.log };
}

function mergeFields(first: JsonObject | undefined, second: JsonObject | undefined): JsonObject | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return { ...first, ...second };
}

function getObservabilityState(): DenWebObservabilityState {
  if (globalThis.__denWebObservabilityState === undefined) {
    globalThis.__denWebObservabilityState = { sink: jsonStdoutSink(), telemetrySdkStarted: false };
  }

  return globalThis.__denWebObservabilityState;
}

export function setStructuredLogSink(nextSink: StructuredLogSink): void {
  getObservabilityState().sink = nextSink;
}

export function useJsonStdoutStructuredLogSink(): void {
  setStructuredLogSink(jsonStdoutSink());
}

export function retainTelemetrySdk(sdk: RetainedTelemetrySdk): void {
  const state = getObservabilityState();
  state.telemetrySdkStarted = true;
  state.retainedTelemetrySdk = sdk;
}

export function isTelemetrySdkStarted(): boolean {
  return getObservabilityState().telemetrySdkStarted;
}

export async function flushRetainedTelemetry(): Promise<void> {
  const sdk = getObservabilityState().retainedTelemetrySdk;
  if (sdk?.forceFlush !== undefined) {
    await sdk.forceFlush();
  }
}

function withShutdownTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      resolve();
    };

    timeout = setTimeout(finish, timeoutMs);
    timeout.unref();
    operation.then(finish, finish);
  });
}

async function bestEffortShutdown(sdk: RetainedTelemetrySdk, timeoutMs: number): Promise<void> {
  if (sdk.forceFlush !== undefined) {
    try {
      await withShutdownTimeout(sdk.forceFlush(), timeoutMs);
    } catch {
      // Best effort only; shutdown should still run after flush failures.
    }
  }

  try {
    await withShutdownTimeout(sdk.shutdown(), timeoutMs);
  } catch {
    // Best effort only; callers should not crash during process shutdown.
  }
}

async function runRetainedTelemetryShutdown(timeoutMs: number): Promise<void> {
  const sdk = getObservabilityState().retainedTelemetrySdk;
  if (sdk === undefined) return;

  try {
    await bestEffortShutdown(sdk, timeoutMs);
  } finally {
    const state = getObservabilityState();
    if (state.retainedTelemetrySdk === sdk) {
      state.retainedTelemetrySdk = undefined;
      state.telemetrySdkStarted = false;
    }
  }
}

export function shutdownRetainedTelemetry(timeoutMs = 1500): Promise<void> {
  const state = getObservabilityState();
  if (state.telemetryShutdownPromise !== undefined) {
    return state.telemetryShutdownPromise;
  }

  const shutdownPromise = runRetainedTelemetryShutdown(timeoutMs).finally(() => {
    const nextState = getObservabilityState();
    if (nextState.telemetryShutdownPromise === shutdownPromise) {
      nextState.telemetryShutdownPromise = undefined;
    }
  });
  state.telemetryShutdownPromise = shutdownPromise;
  return shutdownPromise;
}

export function registerRetainedTelemetryShutdownHandlers(
  target: TelemetrySignalTarget,
  timeoutMs = 1500,
): boolean {
  const state = getObservabilityState();
  if (state.telemetryShutdownHandlersRegistered) return false;

  state.telemetryShutdownHandlersRegistered = true;
  const shutdown = () => {
    void shutdownRetainedTelemetry(timeoutMs);
  };

  target.on("SIGTERM", shutdown);
  target.on("SIGINT", shutdown);
  return true;
}

export function resetDenWebObservabilityStateForTests(): void {
  globalThis.__denWebObservabilityState = undefined;
}

function createLogger(fields?: JsonObject): JsonStdoutLogger {
  const log = (level: StructuredLogLevel, message: string, nextFields?: JsonObject) => {
    getObservabilityState().sink.log(
      level,
      scrubText(message),
      scrubLogFields(mergeFields(fields, nextFields)),
    );
  };

  return {
    log,
    debug: (message, nextFields) => log("debug", message, nextFields),
    info: (message, nextFields) => log("info", message, nextFields),
    warn: (message, nextFields) => log("warn", message, nextFields),
    error: (message, nextFields) => log("error", message, nextFields),
    child: (nextFields) => createLogger(mergeFields(fields, nextFields)),
  };
}

export const denWebLogger = createLogger();
