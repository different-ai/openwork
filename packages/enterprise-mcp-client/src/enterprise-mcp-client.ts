import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js"
import { z } from "zod"
import type {
  EnterpriseMcpAuthorization,
  EnterpriseMcpAbandonAuthorizationInput,
  EnterpriseMcpCallToolInput,
  EnterpriseMcpClient,
  EnterpriseMcpClientOptions,
  EnterpriseMcpClock,
  EnterpriseMcpCompleteAuthorizationInput,
  EnterpriseMcpConnectInput,
  EnterpriseMcpConnectResult,
  EnterpriseMcpConnection,
  EnterpriseMcpFetch,
  EnterpriseMcpLifecycle,
  EnterpriseMcpListToolsInput,
  EnterpriseMcpOperationPhase,
} from "./contracts.js"
import { EnterpriseMcpClientError, EnterpriseMcpToolResultError } from "./errors.js"
import { EnterpriseMcpOAuthProvider } from "./oauth-provider.js"
import { createEnterpriseMcpRequestObserver, type EnterpriseMcpRequestObserver } from "./request-observer.js"
import { collectEnterpriseMcpTools } from "./tool-catalog.js"
import { assertEnterpriseMcpToolArguments } from "./tool-input.js"

const connectionSchema = z.object({
  id: z.string().trim().min(1),
  serverUrl: z.string().trim().url(),
})

const redirectUriSchema = z.string().trim().url()
const clientMetadataUrlSchema = z.string().trim().url().refine((value) => {
  const url = new URL(value)
  return url.protocol === "https:" && url.pathname !== "/"
}, "An OAuth client metadata document URL must use HTTPS and include a path.")
const oauthConfigurationSchema = z.object({
  applicationType: z.enum(["web", "native"]),
  clientMetadataUrl: clientMetadataUrlSchema.optional(),
  authorizationServerIssuer: z.string().trim().url().optional(),
  requestedScopes: z.array(z.string().trim().min(1)).max(128).optional(),
})
const toolNameSchema = z.string().trim().min(1)
const authorizationIdSchema = z.string().min(1).max(8 * 1024)
const authorizationCodeSchema = z.string().min(1).max(8 * 1024)

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000
const DEFAULT_AUTHORIZATION_TRANSACTION_TTL_MS = 10 * 60_000
const DEFAULT_EXPIRATION_SKEW_MS = 30_000

const optionsSchema = z.object({
  operationTimeoutMs: z.number().int().positive(),
  closeTimeoutMs: z.number().int().positive(),
  authorizationTransactionTtlMs: z.number().int().positive(),
  expirationSkewMs: z.number().int().nonnegative(),
  clientName: z.string().trim().min(1).max(255),
  clientVersion: z.string().trim().min(1).max(255),
})

type Session = {
  client: Client
  transport: StreamableHTTPClientTransport
  oauthProvider?: EnterpriseMcpOAuthProvider
  observer: EnterpriseMcpRequestObserver
  controller: AbortController
  requestOptions: RequestOptions
  lifecycle: EnterpriseMcpLifecycle
}

function requestInit(authorization: EnterpriseMcpAuthorization): RequestInit | undefined {
  if (authorization.type !== "api-key") return undefined
  return { headers: { authorization: `Bearer ${authorization.token}` } }
}

function validateConnection(connection: EnterpriseMcpConnection): URL {
  const parsed = connectionSchema.parse({ id: connection.id, serverUrl: connection.serverUrl })
  if (connection.authorization.type === "api-key" && !connection.authorization.token.trim()) {
    throw new Error("An API key connection requires a non-empty token.")
  }
  const url = new URL(parsed.serverUrl)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("An enterprise MCP server URL must use HTTP or HTTPS.")
  }
  if (url.username || url.password) {
    throw new Error("An enterprise MCP server URL cannot contain embedded credentials.")
  }
  if (url.hash) throw new Error("An enterprise MCP server URL cannot contain a fragment.")
  return url
}

function validateRedirectUri(redirectUri: string): string {
  const parsed = redirectUriSchema.parse(redirectUri)
  const url = new URL(parsed)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("An enterprise MCP OAuth redirect URI must use HTTP or HTTPS.")
  }
  if (url.username || url.password || url.hash) {
    throw new Error("An enterprise MCP OAuth redirect URI cannot contain credentials or a fragment.")
  }
  return parsed
}

function configurationValue<T>(parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    throw new EnterpriseMcpClientError({
      operationPhase: "configuration",
      requestPhase: null,
      cause: error,
    })
  }
}

async function closeWithinDeadline(close: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      close(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("The MCP client did not close before its deadline.")), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createEnterpriseMcpClient(options: EnterpriseMcpClientOptions): EnterpriseMcpClient {
  const parsedOptions = configurationValue(() => optionsSchema.parse({
    operationTimeoutMs: options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
    authorizationTransactionTtlMs: options.authorizationTransactionTtlMs ?? DEFAULT_AUTHORIZATION_TRANSACTION_TTL_MS,
    expirationSkewMs: options.expirationSkewMs ?? DEFAULT_EXPIRATION_SKEW_MS,
    clientName: options.clientName ?? "OpenWork",
    clientVersion: options.clientVersion ?? "1.0.0",
  }))
  const {
    operationTimeoutMs,
    closeTimeoutMs,
    authorizationTransactionTtlMs,
    expirationSkewMs,
    clientName,
    clientVersion,
  } = parsedOptions
  const clock: EnterpriseMcpClock = options.clock ?? { now: () => Date.now() }
  const configuredFetch: EnterpriseMcpFetch = options.fetch

  function emitDiagnostic(event: Parameters<NonNullable<EnterpriseMcpClientOptions["diagnosticSink"]>>[0]): void {
    try {
      options.diagnosticSink?.(event)
    } catch {
      // Diagnostics must never change the connection outcome they observe.
    }
  }

  function failureRequestPhase(observer: EnterpriseMcpRequestObserver) {
    return observer.lastFailedRequestPhase() ?? observer.lastRequestPhase()
  }

  function createSession(input: {
    connection: EnterpriseMcpConnection
    redirectUri: string
    flow: { kind: "connect"; authorizationId?: string } | { kind: "callback"; authorizationId: string } | { kind: "runtime" }
    operationPhase: EnterpriseMcpOperationPhase
  }): Session {
    const serverUrl = validateConnection(input.connection)
    const redirectUri = validateRedirectUri(input.redirectUri)
    const oauthConfiguration = input.connection.authorization.type === "oauth"
      ? configurationValue(() => oauthConfigurationSchema.parse(
          input.connection.authorization.type === "oauth"
            ? input.connection.authorization.configuration ?? { applicationType: "web" }
            : { applicationType: "web" },
        ))
      : undefined
    const controller = new AbortController()
    const configuredExpiresAt = options.lifecycle?.expiresAt ?? (clock.now() + operationTimeoutMs)
    const remaining = Math.max(1, Math.min(operationTimeoutMs, configuredExpiresAt - clock.now()))
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Enterprise MCP ${input.operationPhase} exceeded its lifecycle deadline.`))
    }, remaining)
    controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true })

    const observer = createEnterpriseMcpRequestObserver({
      connectionId: input.connection.id,
      operationPhase: input.operationPhase,
      fetch: configuredFetch,
      diagnosticSink: options.diagnosticSink ? emitDiagnostic : undefined,
      signal: options.lifecycle
        ? AbortSignal.any([controller.signal, options.lifecycle.signal])
        : controller.signal,
      clock,
    })
    const requestSignal = options.lifecycle
      ? AbortSignal.any([controller.signal, options.lifecycle.signal])
      : controller.signal
    const oauthProvider = input.connection.authorization.type === "oauth"
      ? new EnterpriseMcpOAuthProvider({
          redirectUri,
          connectionId: input.connection.id,
          persistence: input.connection.authorization.persistence,
          flow: input.flow,
          clientName,
          clock,
          lifecycle: {
            expiresAt: configuredExpiresAt,
            signal: requestSignal,
          },
          authorizationTransactionTtlMs,
          expirationSkewMs,
          oauthConfiguration,
        })
      : undefined
    const transport = new StreamableHTTPClientTransport(serverUrl, {
      authProvider: oauthProvider,
      fetch: observer.fetch,
      requestInit: requestInit(input.connection.authorization),
    })
    const client = new Client({ name: clientName, version: clientVersion }, { capabilities: {} })
    const requestOptions: RequestOptions = {
      signal: requestSignal,
      timeout: remaining,
      maxTotalTimeout: remaining,
      resetTimeoutOnProgress: false,
    }
    return {
      client,
      transport,
      oauthProvider,
      observer,
      controller,
      requestOptions,
      lifecycle: { expiresAt: configuredExpiresAt, signal: requestSignal },
    }
  }

  async function runOperation<T>(input: {
    connection: EnterpriseMcpConnection
    redirectUri: string
    flow: { kind: "connect"; authorizationId?: string } | { kind: "callback"; authorizationId: string } | { kind: "runtime" }
    operationPhase: EnterpriseMcpOperationPhase
    operation: (session: Session) => Promise<T>
  }): Promise<T> {
    let session: Session
    try {
      session = createSession(input)
    } catch (error) {
      throw new EnterpriseMcpClientError({
        operationPhase: "configuration",
        requestPhase: null,
        cause: error,
      })
    }

    emitDiagnostic({
      kind: "operation",
      connectionId: input.connection.id,
      operationPhase: input.operationPhase,
      requestPhase: null,
      outcome: "started",
    })
    const startedAt = clock.now()
    try {
      const result = await input.operation(session)
      emitDiagnostic({
        kind: "operation",
        connectionId: input.connection.id,
        operationPhase: input.operationPhase,
        requestPhase: session.observer.lastRequestPhase(),
        outcome: "succeeded",
        durationMs: clock.now() - startedAt,
      })
      return result
    } catch (error) {
      const wrapped = error instanceof EnterpriseMcpClientError
        ? error
        : new EnterpriseMcpClientError({
            operationPhase: input.operationPhase,
            requestPhase: failureRequestPhase(session.observer),
            cause: error,
          })
      emitDiagnostic({
        kind: "operation",
        connectionId: input.connection.id,
        operationPhase: input.operationPhase,
        requestPhase: failureRequestPhase(session.observer),
        outcome: "failed",
        durationMs: clock.now() - startedAt,
      })
      throw wrapped
    } finally {
      session.controller.abort()
    }
  }

  async function runConnectedOperation<T>(input: {
    connection: EnterpriseMcpConnection
    redirectUri: string
    operationPhase: EnterpriseMcpOperationPhase
    operation: (session: Session) => Promise<T>
  }): Promise<T> {
    return runOperation({
      ...input,
      flow: { kind: "runtime" },
      operation: async (session) => {
        await session.client.connect(session.transport, session.requestOptions)
        emitDiagnostic({
          kind: "operation",
          connectionId: input.connection.id,
          operationPhase: input.operationPhase,
          requestPhase: "mcp-initialize",
          outcome: "succeeded",
        })
        let operationFailed = false
        try {
          return await input.operation(session)
        } catch (error) {
          operationFailed = true
          throw error
        } finally {
          try {
            await closeWithinDeadline(() => session.client.close(), closeTimeoutMs)
          } catch (error) {
            if (!operationFailed) {
              throw new EnterpriseMcpClientError({
                operationPhase: "shutdown",
                requestPhase: session.observer.lastRequestPhase(),
                cause: error,
              })
            }
          }
        }
      },
    })
  }

  return {
    async connect(input: EnterpriseMcpConnectInput): Promise<EnterpriseMcpConnectResult> {
      const authorizationId = configurationValue(() => input.authorizationId === undefined
        ? undefined
        : authorizationIdSchema.parse(input.authorizationId))
      if (input.connection.authorization.type === "oauth" && !authorizationId) {
        throw new EnterpriseMcpClientError({
          operationPhase: "configuration",
          requestPhase: null,
          cause: new Error("An OAuth connection requires a signed authorization transaction id."),
        })
      }
      return runOperation({
        connection: input.connection,
        redirectUri: input.redirectUri,
        flow: { kind: "connect", authorizationId },
        operationPhase: "connection-handshake",
        operation: async (session) => {
          try {
            await session.client.connect(session.transport, session.requestOptions)
            emitDiagnostic({
              kind: "operation",
              connectionId: input.connection.id,
              operationPhase: "connection-handshake",
              requestPhase: "mcp-initialize",
              outcome: "succeeded",
            })
            try {
              await closeWithinDeadline(() => session.client.close(), closeTimeoutMs)
            } catch (error) {
              throw new EnterpriseMcpClientError({
                operationPhase: "shutdown",
                requestPhase: session.observer.lastRequestPhase(),
                cause: error,
              })
            }
            return { status: "connected" }
          } catch (error) {
            const authorizeUrl = session.oauthProvider?.authorizeUrl ?? null
            if (error instanceof UnauthorizedError && authorizeUrl) {
              try {
                await closeWithinDeadline(() => session.client.close(), closeTimeoutMs)
              } catch {
                // The bounded cleanup attempt must not discard a valid authorization URL.
              }
              return { status: "needs_auth", authorizeUrl }
            }
            throw error
          }
        },
      })
    },

    async completeAuthorization(input: EnterpriseMcpCompleteAuthorizationInput): Promise<void> {
      const authorizationId = configurationValue(() => authorizationIdSchema.parse(input.authorizationId))
      const code = configurationValue(() => authorizationCodeSchema.parse(input.code))
      await runOperation({
        connection: input.connection,
        redirectUri: input.redirectUri,
        flow: { kind: "callback", authorizationId },
        operationPhase: "authorization-callback",
        operation: async (session) => {
          const credentialPort = input.connection.authorization.type === "oauth"
            ? input.connection.authorization.persistence.credentials
            : null
          let exchangedTokens = false
          let operationFailed = false
          try {
            await session.transport.finishAuth(code)
            exchangedTokens = true
            await session.client.connect(session.transport, session.requestOptions)
            emitDiagnostic({
              kind: "operation",
              connectionId: input.connection.id,
              operationPhase: "authorization-callback",
              requestPhase: "mcp-initialize",
              outcome: "succeeded",
            })
          } catch (error) {
            operationFailed = true
            if (exchangedTokens && credentialPort) {
              try {
                const cleanupController = new AbortController()
                await credentialPort.invalidate({
                  context: {
                    connectionId: input.connection.id,
                    commitExpiresAt: clock.now() + closeTimeoutMs,
                    signal: cleanupController.signal,
                  },
                  reason: "post-authorization-validation-failed",
                })
              } catch {
                // Credential cleanup must not replace the validation failure.
              }
            }
            throw error
          } finally {
            try {
              await closeWithinDeadline(() => session.client.close(), closeTimeoutMs)
            } catch (error) {
              if (!operationFailed) {
                throw new EnterpriseMcpClientError({
                  operationPhase: "shutdown",
                  requestPhase: session.observer.lastRequestPhase(),
                  cause: error,
                })
              }
            }
          }
        },
      })
    },

    async abandonAuthorization(input: EnterpriseMcpAbandonAuthorizationInput): Promise<void> {
      const authorizationId = configurationValue(() => authorizationIdSchema.parse(input.authorizationId))
      if (input.connection.authorization.type !== "oauth") return
      const controller = new AbortController()
      const expiresAt = Math.min(
        options.lifecycle?.expiresAt ?? (clock.now() + operationTimeoutMs),
        clock.now() + operationTimeoutMs,
      )
      await input.connection.authorization.persistence.authorizations.invalidate({
        context: {
          connectionId: input.connection.id,
          commitExpiresAt: expiresAt,
          signal: options.lifecycle
            ? AbortSignal.any([controller.signal, options.lifecycle.signal])
            : controller.signal,
        },
        id: authorizationId,
        reason: input.reason,
      })
    },

    async listTools(input: EnterpriseMcpListToolsInput) {
      return runConnectedOperation({
        connection: input.connection,
        redirectUri: input.redirectUri,
        operationPhase: "tool-discovery",
        operation: async (session) => {
          return collectEnterpriseMcpTools({
            requestOptions: session.requestOptions,
            listPage: (cursor, options) => session.client.listTools(
              cursor ? { cursor } : undefined,
              options,
            ),
          })
        },
      })
    },

    async callTool(input: EnterpriseMcpCallToolInput) {
      const toolName = configurationValue(() => toolNameSchema.parse(input.toolName))
      configurationValue(() => assertEnterpriseMcpToolArguments(input.arguments))
      return runConnectedOperation({
        connection: input.connection,
        redirectUri: input.redirectUri,
        operationPhase: "tool-execution",
        operation: async (session) => {
          const result = await session.client.callTool({
            name: toolName,
            arguments: input.arguments,
          }, undefined, session.requestOptions)
          if ("isError" in result && result.isError) throw new EnterpriseMcpToolResultError(result)
          return result
        },
      })
    },
  }
}
