import {
  auth,
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client"
import type { RequestOptions } from "@modelcontextprotocol/client"
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
  EnterpriseMcpListResourcesInput,
  EnterpriseMcpListResourceTemplatesInput,
  EnterpriseMcpListToolsInput,
  EnterpriseMcpOperationPhase,
  EnterpriseMcpRequestPhase,
  EnterpriseMcpReadResourceInput,
} from "./contracts.js"
import { EnterpriseMcpClientError, EnterpriseMcpLifecycleDeadlineError, EnterpriseMcpToolResultError } from "./errors.js"
import { EnterpriseMcpOAuthProvider } from "./oauth-provider.js"
import { createEnterpriseMcpRequestObserver, type EnterpriseMcpRequestObserver } from "./request-observer.js"
import { createEnterpriseMcpTokenResponseCompat } from "./token-response-compat.js"
import { collectEnterpriseMcpTools } from "./tool-catalog.js"
import {
  assertEnterpriseMcpResourceResult,
  collectEnterpriseMcpResources,
  collectEnterpriseMcpResourceTemplates,
  ENTERPRISE_MCP_RESOURCE_URI_LIMIT_BYTES,
} from "./resource-catalog.js"
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
const resourceUriSchema = z.string().trim().min(1).max(ENTERPRISE_MCP_RESOURCE_URI_LIMIT_BYTES).refine(
  (value) => Buffer.byteLength(value, "utf8") <= ENTERPRISE_MCP_RESOURCE_URI_LIMIT_BYTES,
  "MCP resource URIs must not exceed 16 KiB.",
)
const authorizationIdSchema = z.string().min(1).max(8 * 1024)
const authorizationCodeSchema = z.string().min(1).max(8 * 1024)

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000
const DEFAULT_AUTHORIZATION_TRANSACTION_TTL_MS = 10 * 60_000
const DEFAULT_EXPIRATION_SKEW_MS = 30_000
const MCP_APP_EXTENSION = "io.modelcontextprotocol/ui"
const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app"

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
  serverUrl: URL
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
  const explicitOperationTimeoutMs = options.operationTimeoutMs
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

  function isMcpResourceRequest(phase: EnterpriseMcpRequestPhase): boolean {
    return phase === "mcp-discovery"
      || phase === "mcp-initialize"
      || phase === "mcp-tool-discovery"
      || phase === "mcp-tool-execution"
      || phase === "mcp-resource-discovery"
      || phase === "mcp-resource-read"
      || phase === "endpoint-request"
  }

  async function invalidateTerminallyRejectedCredential(
    session: Session,
    input: { connectionId: string; operationPhase: EnterpriseMcpOperationPhase },
  ): Promise<void> {
    if (!session.oauthProvider || !["tool-execution", "resource-discovery", "resource-read"].includes(input.operationPhase)) return
    const failure = session.observer.lastRequestFailure()
    if (!failure || !isMcpResourceRequest(failure.requestPhase)) return
    const rejected = (failure.httpStatus === 401 && failure.invalidToken)
      || (failure.httpStatus === 403 && (failure.bearerChallenge || failure.insufficientScope))
    if (!rejected) return
    await session.oauthProvider.invalidateCredentials("tokens")
    emitDiagnostic({
      kind: "credential-invalidation",
      connectionId: input.connectionId,
      operationPhase: input.operationPhase,
      requestPhase: failure.requestPhase,
      httpStatus: failure.httpStatus,
      invalidToken: failure.invalidToken,
    })
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
    const remaining = Math.max(1, configuredExpiresAt - clock.now())
    const maxRequestTimeoutMs = remaining > 1 ? remaining - 1 : remaining
    const requestTimeoutMs = Math.max(1, Math.min(
      options.lifecycle ? explicitOperationTimeoutMs ?? maxRequestTimeoutMs : operationTimeoutMs,
      maxRequestTimeoutMs,
    ))
    const timeout = setTimeout(() => {
      controller.abort(new EnterpriseMcpLifecycleDeadlineError(input.operationPhase))
    }, remaining)
    controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true })

    const compatibleFetch = createEnterpriseMcpTokenResponseCompat({
      fetch: configuredFetch,
      onTranslation: (translation) => emitDiagnostic({
        kind: "request",
        connectionId: input.connection.id,
        operationPhase: input.operationPhase,
        requestPhase: translation.requestPhase,
        outcome: translation.outcome,
        httpStatus: translation.httpStatus,
        responseBodyExcerpt: translation.responseBodyExcerpt,
      }),
    })
    const observer = createEnterpriseMcpRequestObserver({
      connectionId: input.connection.id,
      operationPhase: input.operationPhase,
      fetch: compatibleFetch,
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
          fetch: observer.fetch,
          oauthConfiguration,
        })
      : undefined
    const transport = new StreamableHTTPClientTransport(serverUrl, {
      authProvider: oauthProvider,
      fetch: observer.fetch,
      requestInit: requestInit(input.connection.authorization),
    })
    const capabilities = {
      extensions: {
        [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] },
      },
    }
    const client = new Client(
      { name: clientName, version: clientVersion },
      {
        capabilities,
        versionNegotiation: { mode: "auto" },
      },
    )
    const requestOptions: RequestOptions = {
      signal: requestSignal,
      timeout: requestTimeoutMs,
      maxTotalTimeout: remaining,
      resetTimeoutOnProgress: true,
      onprogress: () => undefined,
    }
    return {
      client,
      transport,
      serverUrl,
      oauthProvider,
      observer,
      controller,
      requestOptions,
      lifecycle: { expiresAt: configuredExpiresAt, signal: requestSignal },
    }
  }

  async function connectWithProtocolNegotiation(input: {
    session: Session
    connectionId: string
    operationPhase: EnterpriseMcpOperationPhase
  }): Promise<void> {
    await input.session.client.connect(input.session.transport, input.session.requestOptions)
    emitDiagnostic({
      kind: "operation",
      connectionId: input.connectionId,
      operationPhase: input.operationPhase,
      requestPhase: input.session.observer.lastRequestPhase(),
      outcome: "succeeded",
      protocolEra: input.session.client.getProtocolEra(),
      protocolVersion: input.session.client.getNegotiatedProtocolVersion(),
    })
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
        try {
          await connectWithProtocolNegotiation({
            session,
            connectionId: input.connection.id,
            operationPhase: input.operationPhase,
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
        } catch (error) {
          await invalidateTerminallyRejectedCredential(session, {
            connectionId: input.connection.id,
            operationPhase: input.operationPhase,
          })
          throw error
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
            const hadOAuthCredential = session.oauthProvider
              ? Boolean(await session.oauthProvider.tokens())
              : false
            await connectWithProtocolNegotiation({
              session,
              connectionId: input.connection.id,
              operationPhase: "connection-handshake",
            })
            // Some providers allow protocol negotiation before challenging on tools/list.
            // Probe only when the server advertised the tools capability: MCP
            // servers are allowed to expose resources and/or prompts without
            // implementing tools/list at all.
            if (session.client.getServerCapabilities()?.tools) {
              await session.client.listTools(undefined, session.requestOptions)
            }
            // OAuth connections must not be treated as member-connected merely
            // because a provider exposes protocol negotiation and tools/list publicly.
            // When no member credential exists, proactively run OAuth discovery
            // so providers such as BigQuery can return an authorization URL
            // without first issuing an MCP-level 401 challenge.
            if (session.oauthProvider && !hadOAuthCredential) {
              const authResult = await auth(session.oauthProvider, {
                serverUrl: session.serverUrl,
                fetchFn: session.observer.fetch,
              })
              const authorizeUrl = session.oauthProvider.authorizeUrl
              if (authResult === "REDIRECT") {
                if (!authorizeUrl) {
                  throw new Error("The OAuth provider requested authorization without an authorization URL.")
                }
                try {
                  await closeWithinDeadline(() => session.client.close(), closeTimeoutMs)
                } catch {
                  // The bounded cleanup attempt must not discard a valid authorization URL.
                }
                return { status: "needs_auth", authorizeUrl }
              }
            }
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
            await connectWithProtocolNegotiation({
              session,
              connectionId: input.connection.id,
              operationPhase: "authorization-callback",
            })
            if (session.client.getServerCapabilities()?.tools) {
              await session.client.listTools(undefined, session.requestOptions)
            }
            await session.oauthProvider?.commitPendingAuthorizationCodeCredential()
          } catch (error) {
            operationFailed = true
            let credentialCleanupError: unknown = null
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
              } catch (cleanupError) {
                credentialCleanupError = cleanupError
              }
            }
            if (credentialCleanupError) {
              throw new EnterpriseMcpClientError({
                operationPhase: "authorization-callback",
                requestPhase: session.observer.lastRequestPhase(),
                cause: new AggregateError(
                  [error, credentialCleanupError],
                  "Post-authorization validation failed and the exchanged credentials could not be invalidated.",
                ),
              })
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
      const expiresAt = options.lifecycle?.expiresAt ?? (clock.now() + operationTimeoutMs)
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

    async callToolRaw(input: EnterpriseMcpCallToolInput) {
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
          }, session.requestOptions)
          return result
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
          }, session.requestOptions)
          if ("isError" in result && result.isError) throw new EnterpriseMcpToolResultError(result)
          return result
        },
      })
    },

    async listResources(input: EnterpriseMcpListResourcesInput) {
      return runConnectedOperation({
        connection: input.connection,
        redirectUri: input.redirectUri,
        operationPhase: "resource-discovery",
        operation: (session) => collectEnterpriseMcpResources({
          requestOptions: session.requestOptions,
          listPage: (cursor, options) => session.client.listResources(
            cursor ? { cursor } : undefined,
            options,
          ),
        }),
      })
    },

    async readResource(input: EnterpriseMcpReadResourceInput) {
      const uri = configurationValue(() => resourceUriSchema.parse(input.uri))
      return runConnectedOperation({
        connection: input.connection,
        redirectUri: input.redirectUri,
        operationPhase: "resource-read",
        operation: async (session) => {
          const result = await session.client.readResource({ uri }, session.requestOptions)
          assertEnterpriseMcpResourceResult(result)
          return result
        },
      })
    },

    async listResourceTemplates(input: EnterpriseMcpListResourceTemplatesInput) {
      return runConnectedOperation({
        connection: input.connection,
        redirectUri: input.redirectUri,
        operationPhase: "resource-discovery",
        operation: (session) => collectEnterpriseMcpResourceTemplates({
          requestOptions: session.requestOptions,
          listPage: (cursor, options) => session.client.listResourceTemplates(
            cursor ? { cursor } : undefined,
            options,
          ),
        }),
      })
    },

    async describeServer(input: EnterpriseMcpListResourcesInput) {
      return runConnectedOperation({
        connection: input.connection,
        redirectUri: input.redirectUri,
        operationPhase: "protocol-initialize",
        operation: async (session) => {
          const instructions = session.client.getInstructions()
          const serverInfo = session.client.getServerVersion()
          return {
            capabilities: session.client.getServerCapabilities() ?? {},
            ...(serverInfo ? { serverInfo } : {}),
            ...(instructions ? { instructions } : {}),
          }
        },
      })
    },
  }
}
