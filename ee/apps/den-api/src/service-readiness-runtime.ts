import { sql } from "@openwork-ee/den-db/drizzle"
import { verifyEmailTransport } from "@openwork/email"
import type { DeploymentServiceReadiness, OrganizationServiceReadiness } from "@openwork/types/den/service-readiness"
import { Agent, fetch as undiciFetch } from "undici"
import { db } from "./db.js"
import { cache } from "./cache.js"
import { env } from "./env.js"
import { denServerFacts } from "./server-start.js"
import { checkRateLimit } from "./utils/rate-limit.js"
import { createReadinessController, EMAIL_READINESS_TIMEOUT_MS, initialReadiness, organizationReadiness, probeDeploymentServices, readinessConfigurationFingerprint, readinessLookup, readinessServiceHosts, SERVICE_READINESS_RATE_KEY, SERVICE_READINESS_RATE_WINDOW_MS, SERVICE_READINESS_TIMEOUT_MS, type ReadinessFetch } from "./service-readiness.js"

// Operator environment is fixed for this replica's lifetime. Use the same
// configuration for DNS policy, probes, initial facts and the private cache key.
const readinessEnvironment = { ...process.env }
const allowedPrivateHosts = readinessServiceHosts(readinessEnvironment)
const configurationFingerprint = readinessConfigurationFingerprint(readinessEnvironment, env.apiPublicUrl)

function readinessAgent(timeoutMs: number, privateHosts?: ReadonlySet<string>) {
  return new Agent({
    connect: {
      timeout: timeoutMs,
      lookup(hostname, options, callback) {
        void readinessLookup(hostname, undefined, privateHosts).then((addresses) => {
          if (options.all) callback(null, addresses)
          else callback(null, addresses[0].address, addresses[0].family)
        }, () => callback(new Error("request_failed"), []))
      },
    },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connections: 4,
  })
}

function readinessFetch(agent: Agent): ReadinessFetch {
  return async (url, init) => {
    const requestHeaders: Record<string, string> = {}
    new Headers(init.headers).forEach((value, name) => { requestHeaders[name] = value })
    const response = await undiciFetch(url, {
      method: "GET", headers: requestHeaders, signal: init.signal, redirect: "manual", dispatcher: agent,
    })
    // Match Hono's current Response realm without eagerly consuming untrusted bodies.
    let body: ReadableStream<Uint8Array> | null = null
    if (response.body) {
      const reader = response.body.getReader()
      body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const chunk = await reader.read()
          if (chunk.done) controller.close()
          else controller.enqueue(chunk.value)
        },
        cancel(reason: unknown) { return reader.cancel(reason) },
      })
    }
    const headers = new Headers()
    response.headers.forEach((value, name) => headers.append(name, value))
    return new Response(body, { status: response.status, headers })
  }
}

const serviceFetch = readinessFetch(readinessAgent(SERVICE_READINESS_TIMEOUT_MS, allowedPrivateHosts))
// The mail provider API is a public endpoint: default public-only DNS policy, no operator private hosts.
const emailFetch = readinessFetch(readinessAgent(EMAIL_READINESS_TIMEOUT_MS))

// Drizzle/PlanetScale cannot cancel a query. Keep the one underlying SELECT shared
// even after a diagnostic timeout so a broken database never accumulates probes.
let databaseQuery: Promise<unknown> | null = null
function database() {
  databaseQuery ??= Promise.resolve(db.execute(sql`select 1`)).finally(() => { databaseQuery = null })
  return databaseQuery
}

// Same settings the send path uses (utils/email/send-email.ts). Read-only: nothing is sent.
function verifyEmail(signal: AbortSignal) {
  return verifyEmailTransport({
    devMode: env.devMode,
    from: env.email.from,
    resendApiKey: env.resend.apiKey,
    smtp: env.smtp,
  }, { timeoutMs: EMAIL_READINESS_TIMEOUT_MS - 250, signal, fetch: emailFetch })
}

export const serviceReadiness = createReadinessController({
  initial: initialReadiness(readinessEnvironment, env.apiPublicUrl),
  admit: () => checkRateLimit(SERVICE_READINESS_RATE_KEY, 1, SERVICE_READINESS_RATE_WINDOW_MS, Date.now()),
  probe: () => probeDeploymentServices({ env: readinessEnvironment, denOrigin: env.apiPublicUrl, database, fetch: serviceFetch, verifyEmail }),
  load: () => cache.serviceReadiness.load(configurationFingerprint),
  save: (snapshot) => cache.serviceReadiness.save(configurationFingerprint, snapshot),
})

/** The shared snapshot plus this replica's server facts. Never starts a check. */
export function currentDeploymentServices(): DeploymentServiceReadiness {
  return { ...serviceReadiness.snapshot(), server: denServerFacts() }
}

/**
 * Read for an authorized operator/admin: synchronizes the shared cache and, when
 * anything is stale, queues a background check (stale-while-revalidate). Never
 * waits for a probe. The minimal organization projection never calls this.
 */
export function deploymentServicesSnapshot(): DeploymentServiceReadiness {
  serviceReadiness.syncCache()
  if (serviceReadiness.snapshot().services.some((status) => status.stale)) void serviceReadiness.refresh().catch(() => undefined)
  return currentDeploymentServices()
}

/**
 * Check now. Coalesces active and recently completed checks; otherwise takes the
 * durable deployment admission. null when a check is queued, running or fresh;
 * otherwise seconds until another check may be admitted. Throws only when the
 * durable limiter is unavailable (callers answer 503 without detail).
 */
export function refreshDeploymentServices(): Promise<number | null> {
  return serviceReadiness.refresh()
}

/** No probe, no outbound HTTP, and no member/provider credentials inspected. */
export async function cachedOrganizationServiceReadiness(): Promise<OrganizationServiceReadiness | undefined> {
  try {
    serviceReadiness.syncCache()
    return organizationReadiness(serviceReadiness.snapshot())
  } catch {
    // This advisory projection must not introduce a new failure into /v1/org.
    return undefined
  }
}
