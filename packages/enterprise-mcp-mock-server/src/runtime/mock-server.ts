import { randomBytes, randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { ZodError } from "zod"
import { enterpriseMcpMockSecretsSchema, ScenarioRevisionConflictError } from "../contracts/runtime.js"
import type {
  CreateEnterpriseMcpMockServerOptions,
  EnterpriseMcpMockServer,
  RuntimeSnapshot,
  SafeTraceEvent,
  EnterpriseMcpMockEnvironment,
} from "../contracts/runtime.js"
import { scenarioSchema, type EnterpriseMcpScenario } from "../contracts/scenario.js"
import { getProviderProfile } from "../profiles/profiles.js"
import { getFaultDefinition } from "../faults/catalog.js"
import { InstanceState } from "./instance-state.js"
import { handleOAuthRequest } from "../protocol/oauth-handler.js"
import { handleMcpRequest } from "../protocol/mcp-handler.js"
import { HttpInputError, requestUrl, sendJson } from "../protocol/http-utils.js"

const defaultHost = "127.0.0.1"
const shutdownGraceMs = 500

function validateHost(host: string): void {
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Enterprise MCP mock servers bind to loopback only")
  }
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off("error", onError)
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Mock server did not expose a TCP address"))
        return
      }
      resolve(address.port)
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

class EnterpriseMcpMockServerRuntime implements EnterpriseMcpMockServer {
  private readonly host: string
  private readonly configuredPort: number
  private readonly secrets: ReturnType<typeof enterpriseMcpMockSecretsSchema.parse>
  private state: InstanceState
  private server: Server | null = null
  private sockets = new Set<Socket>()
  private activeRequestCount = 0
  private resolvedBaseUrl: string | null = null
  private lifecycleTail: Promise<void> = Promise.resolve()
  private listenAttempt = 0
  private readonly environment: EnterpriseMcpMockEnvironment

  constructor(options: CreateEnterpriseMcpMockServerOptions) {
    this.host = options.host ?? defaultHost
    this.configuredPort = options.port ?? 0
    validateHost(this.host)
    if (!Number.isInteger(this.configuredPort) || this.configuredPort < 0 || this.configuredPort > 65_535) {
      throw new Error("Mock server port must be an integer from 0 through 65535")
    }
    const scenario = scenarioSchema.parse(options.scenario)
    this.secrets = enterpriseMcpMockSecretsSchema.parse(options.secrets)
    const profile = getProviderProfile(scenario.profileId)
    if (
      scenario.oauth.registration === "manual" &&
      profile.oauth.defaultClientAuthenticationMethod === "client_secret_post" &&
      this.secrets.oauthClientSecret.length < 12
    ) {
      throw new Error(`Profile '${profile.id}' requires an OAuth client secret with at least 12 characters`)
    }
    this.environment =
      options.environment ??
      {
        now: () => Date.now(),
        randomId: () => randomUUID(),
        opaqueValue: (prefix) => `${prefix}-${randomBytes(24).toString("base64url")}`,
      }
    this.state = this.createState(scenario)
  }

  get baseUrl(): string {
    if (!this.resolvedBaseUrl) throw new Error("Enterprise MCP mock server has not started")
    return this.resolvedBaseUrl
  }

  get mcpUrl(): string {
    return new URL(this.state.profile.endpointPath, this.baseUrl).href
  }

  async start(): Promise<RuntimeSnapshot> {
    return this.serializeLifecycle(() => this.startUnsafe())
  }

  async stop(): Promise<RuntimeSnapshot> {
    return this.serializeLifecycle(async () => {
      await this.stopListener()
      this.state.clearConnectionState()
      this.resolvedBaseUrl = null
      this.state.setRuntime("stopped", null)
      return this.snapshot()
    })
  }

  async reset(): Promise<RuntimeSnapshot> {
    return this.serializeLifecycle(async () => {
      const wasRunning = this.server !== null
      await this.stopListener()
      this.state.clearEphemeralState()
      this.state.clearEvents()
      this.resolvedBaseUrl = null
      this.state.setRuntime(wasRunning ? "idle" : "stopped", null)
      return wasRunning ? this.startUnsafe() : this.snapshot()
    })
  }

  async updateScenario(nextValue: EnterpriseMcpScenario, expectedRevision: number): Promise<RuntimeSnapshot> {
    return this.serializeLifecycle(async () => {
      const currentRevision = this.state.scenario.revision
      if (currentRevision !== expectedRevision) throw new ScenarioRevisionConflictError(expectedRevision, currentRevision)
      const next = scenarioSchema.parse(nextValue)
      if (next.revision !== expectedRevision + 1) {
        throw new Error(`Next scenario revision must be ${expectedRevision + 1}`)
      }
      const wasRunning = this.server !== null
      const previousState = this.state
      await this.stopListener()
      this.resolvedBaseUrl = null
      const nextState = this.createState(next, previousState.instanceId)
      this.state = nextState
      nextState.setRuntime(wasRunning ? "idle" : "stopped", null)
      this.state.emit({
        correlationId: this.environment.randomId(),
        scenario: next,
        phase: "CONFIGURATION",
        direction: "internal",
        kind: "lifecycle",
        outcome: "completed",
        summary: "Activated a new immutable mock scenario revision",
        details: { revision: next.revision, profileId: next.profileId, faultId: next.activeFault?.id ?? null },
      })
      if (!wasRunning) return this.snapshot()
      try {
        return await this.startUnsafe()
      } catch (activationError) {
        this.state = previousState
        previousState.setRuntime("idle", null)
        try {
          await this.startUnsafe()
        } catch (rollbackError) {
          previousState.setRuntime("stopped", null)
          throw new AggregateError(
            [activationError, rollbackError],
            "Scenario activation failed and the prior listener could not be restored",
          )
        }
        throw activationError
      }
    })
  }

  snapshot(): RuntimeSnapshot {
    return this.state.snapshot(
      this.state.scenario.oauth.registration === "manual" &&
        this.state.profile.oauth.defaultClientAuthenticationMethod === "client_secret_post" &&
        this.secrets.oauthClientSecret.length > 0,
    )
  }

  events(): readonly SafeTraceEvent[] {
    return this.state.events()
  }

  private async startUnsafe(): Promise<RuntimeSnapshot> {
    if (this.server) return this.snapshot()
    this.seedManualClient()
    const server = createServer((request, response) => {
      this.activeRequestCount += 1
      let finalized = false
      const finalize = (): void => {
        if (finalized) return
        finalized = true
        this.activeRequestCount = Math.max(0, this.activeRequestCount - 1)
      }
      response.once("finish", finalize)
      response.once("close", finalize)
      void this.route(request, response)
    })
    server.on("connection", (socket) => {
      this.sockets.add(socket)
      socket.once("close", () => this.sockets.delete(socket))
    })
    this.server = server
    try {
      this.listenAttempt += 1
      await this.environment.beforeListen?.(this.listenAttempt)
      const port = await listen(server, this.configuredPort, this.host)
      const formattedHost = this.host === "::1" ? "[::1]" : this.host
      this.resolvedBaseUrl = `http://${formattedHost}:${port}`
      this.state.setRuntime("running", this.resolvedBaseUrl)
      this.state.emit({
        correlationId: this.environment.randomId(),
        scenario: this.state.scenario,
        phase: "CONFIGURATION",
        direction: "internal",
        kind: "lifecycle",
        outcome: "completed",
        summary: "Started an isolated enterprise MCP mock data plane",
        details: { host: this.host, port, profileId: this.state.profile.id },
      })
      return this.snapshot()
    } catch (error) {
      this.server = null
      this.resolvedBaseUrl = null
      this.state.setRuntime("stopped", null)
      throw error
    }
  }

  private createState(scenario: EnterpriseMcpScenario, instanceId?: string): InstanceState {
    const knownSecrets = [this.secrets.oauthClientSecret]
    return new InstanceState(scenario, getProviderProfile(scenario.profileId), knownSecrets, this.environment, instanceId)
  }

  private seedManualClient(): void {
    const { scenario, profile } = this.state
    if (scenario.oauth.registration !== "manual" || this.state.clients.has(scenario.oauth.clientId)) return
    const tokenEndpointAuthMethod = profile.oauth.defaultClientAuthenticationMethod
    this.state.putClient({
      clientId: scenario.oauth.clientId,
      clientSecret: tokenEndpointAuthMethod === "client_secret_post" ? this.secrets.oauthClientSecret : "",
      redirectUris: scenario.oauth.redirectUris,
      tokenEndpointAuthMethod,
      createdAt: this.environment.now(),
      expiresAt: null,
    })
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const scenario = this.state.scenario
    const profile = this.state.profile
    const correlationId = this.environment.randomId()
    this.state.maintainBounds()
    try {
      const baseUrl = this.baseUrl
      const url = requestUrl(request, baseUrl)
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          status: "ok",
          instanceId: this.state.instanceId,
          profileId: profile.id,
          scenarioRevision: scenario.revision,
          mcpUrl: new URL(profile.endpointPath, baseUrl).href,
        })
        return
      }
      const activeFault = scenario.activeFault ? getFaultDefinition(scenario.activeFault.id) : undefined
      if (
        await handleOAuthRequest({ request, response, url, baseUrl, correlationId, scenario, profile, state: this.state, activeFault })
      ) {
        return
      }
      if (url.pathname === profile.endpointPath) {
        await handleMcpRequest({ request, response, baseUrl, correlationId, scenario, profile, state: this.state, activeFault })
        return
      }
      sendJson(response, 404, { error: "not_found" })
    } catch (error) {
      if (response.headersSent || response.destroyed) return
      if (error instanceof HttpInputError) {
        sendJson(response, error.status, { error: "invalid_http_input", message: error.message })
        return
      }
      if (error instanceof ZodError) {
        sendJson(response, 400, { error: "invalid_request", issues: error.issues.map((issue) => issue.message) })
        return
      }
      this.state.emit({
        correlationId,
        scenario,
        phase: "HTTP_ROUTING",
        direction: "internal",
        kind: "lifecycle",
        outcome: "failed",
        summary: "The mock server rejected an unexpected internal error safely",
      })
      sendJson(response, 500, { error: "mock_internal_error", diagnosticId: correlationId })
    }
  }

  private async stopListener(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    const closing = close(server)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, shutdownGraceMs)
      timeout.unref()
    })
    await Promise.race([closing, deadline])
    if (timeout) clearTimeout(timeout)
    if (this.activeRequestCount > 0 || this.sockets.size > 0) {
      for (const socket of this.sockets) socket.destroy()
      this.sockets.clear()
      this.activeRequestCount = 0
    }
    await closing
    this.resolvedBaseUrl = null
  }

  private serializeLifecycle<Output>(operation: () => Promise<Output>): Promise<Output> {
    const result = this.lifecycleTail.then(operation, operation)
    this.lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

export function createEnterpriseMcpMockServer(options: CreateEnterpriseMcpMockServerOptions): EnterpriseMcpMockServer {
  return new EnterpriseMcpMockServerRuntime(options)
}
