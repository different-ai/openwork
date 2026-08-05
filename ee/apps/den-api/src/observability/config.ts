import "../load-env.js"

import { parseObservabilityEnv } from "@micx-ee/utils/observability"
import type { ObservabilityConfig, ObservabilityEnv } from "@micx-ee/utils/observability"

const SERVICE_NAME = "den-api"

function serviceNameFromEnv(env: ObservabilityEnv) {
  const configured = env.OTEL_SERVICE_NAME?.trim()
  return configured || SERVICE_NAME
}

export function parseDenApiObservabilityConfig(env: ObservabilityEnv): ObservabilityConfig {
  return parseObservabilityEnv(env, { serviceName: serviceNameFromEnv(env) })
}

export const observabilityConfig = parseDenApiObservabilityConfig(process.env)
