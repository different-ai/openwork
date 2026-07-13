import { parseObservabilityEnv } from "@openwork-ee/utils/observability";
import type { ObservabilityBackend, ObservabilityConfig, ObservabilityEnv } from "@openwork-ee/utils/observability";

export const denWebServiceName = "den-web";

export type NextRuntime = string | undefined;

export type InstrumentationAction = "none" | "otel-node" | "sentry-edge" | "sentry-server";

export function getDenWebServiceName(env: ObservabilityEnv = process.env): string {
  const serviceName = env.OTEL_SERVICE_NAME?.trim();
  return serviceName ? serviceName : denWebServiceName;
}

export function getDenWebObservabilityConfig(env: ObservabilityEnv = process.env): ObservabilityConfig {
  return parseObservabilityEnv(env, { serviceName: getDenWebServiceName(env) });
}

export function resolveInstrumentationActionForBackend(
  backend: ObservabilityBackend,
  runtime: NextRuntime,
): InstrumentationAction {
  if (backend === "otel") {
    return runtime === "nodejs" ? "otel-node" : "none";
  }

  if (backend === "sentry") {
    if (runtime === "nodejs") return "sentry-server";
    if (runtime === "edge" || runtime === "experimental-edge") return "sentry-edge";
  }

  return "none";
}

export function resolveInstrumentationAction(
  env: ObservabilityEnv = process.env,
  runtime: NextRuntime = process.env.NEXT_RUNTIME,
): InstrumentationAction {
  return resolveInstrumentationActionForBackend(getDenWebObservabilityConfig(env).backend, runtime);
}
