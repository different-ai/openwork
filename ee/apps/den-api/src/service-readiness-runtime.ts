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
const emailFetch = readinessFetch(readinessAgent(EMAIL_READINESS_TIMEOUT_MS))

let databaseQuery: Promise<unknown> | null = null
function database() {
  databaseQuery ??= Promise.resolve(db.execute(sql`select 1`)).finally(() => { databaseQuery = null })
  return databaseQuery
}

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

export function currentDeploymentServices(): DeploymentServiceReadiness {
  return { ...serviceReadiness.snapshot(), server: denServerFacts() }
}

export function deploymentServicesSnapshot(): DeploymentServiceReadiness {
  serviceReadiness.syncCache()
  if (serviceReadiness.snapshot().services.some((status) => status.stale)) void serviceReadiness.refresh().catch(() => undefined)
  return currentDeploymentServices()
}

export function refreshDeploymentServices(): Promise<number | null> {
  return serviceReadiness.refresh()
}

export async function cachedOrganizationServiceReadiness(): Promise<OrganizationServiceReadiness | undefined> {
  try {
    serviceReadiness.syncCache()
    return organizationReadiness(serviceReadiness.snapshot())
  } catch {
    return undefined
  }
}
