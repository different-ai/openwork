import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js"
import { z } from "zod"
import type {
  EnterpriseMcpAuthorization,
  EnterpriseMcpCallToolInput,
  EnterpriseMcpClient,
  EnterpriseMcpClientOptions,
  EnterpriseMcpCompleteAuthorizationInput,
  EnterpriseMcpConnectInput,
  EnterpriseMcpConnectResult,
  EnterpriseMcpConnection,
  EnterpriseMcpFetch,
  EnterpriseMcpListToolsInput,
  EnterpriseMcpOperationPhase,
} from "./contracts.js"
import { EnterpriseMcpClientError, EnterpriseMcpToolResultError } from "./errors.js"
import { EnterpriseMcpOAuthProvider } from "./oauth-provider.js"
import { createEnterpriseMcpRequestObserver, type EnterpriseMcpRequestObserver } from "./request-observer.js"

const connectionSchema = z.object({
  id: z.string().trim().min(1),
  serverUrl: z.string().trim().url(),
})

const redirectUriSchema = z.string().trim().url()
const toolNameSchema = z.string().trim().min(1)

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000

type Session = {
  client: Client
  transport: StreamableHTTPClientTransport
  oauthProvider?: EnterpriseMcpOAuthProvider
  observer: EnterpriseMcpRequestObserver
  controller: AbortController
  requestOptions: RequestOptions
}

function defaultFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetch(url, init)
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
  return new URL(parsed.serverUrl)
}

function validateRedirectUri(redirectUri: string): string {
  return redirectUriSchema.parse(redirectUri)
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

export function createEnterpriseMcpClient(options: EnterpriseMcpClientOptions = {}): EnterpriseMcpClient {
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
  const clientName = options.clientName ?? "OpenWork"
  const clientVersion = options.clientVersion ?? "1.0.0"
  const configuredFetch: EnterpriseMcpFetch = options.fetch ?? defaultFetch

  function emitDiagnostic(event: Parameters<NonNullable<EnterpriseMcpClientOptions["diagnosticSink"]>>[0]): void {
    try {
      options.diagnosticSink?.(event)
    } catch {
      // Diagnostics must never change the connection outcome they observe.
    }
  }

  function createSession(input: {
    connection: EnterpriseMcpConnection
    redirectUri: string
    state?: string
    operationPhase: EnterpriseMcpOperationPhase
  }): Session {
    const serverUrl = validateConnection(input.connection)
    const redirectUri = validateRedirectUri(input.redirectUri)
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Enterprise MCP ${input.operationPhase} exceeded ${operationTimeoutMs}ms.`))
    }, operationTimeoutMs)
    controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true })

    const observer = createEnterpriseMcpRequestObserver({
      connectionId: input.connection.id,
      operationPhase: input.operationPhase,
      fetch: configuredFetch,
      diagnosticSink: options.diagnosticSink ? emitDiagnostic : undefined,
      signal: controller.signal,
    })
    const oauthProvider = input.connection.authorization.type === "oauth"
      ? new EnterpriseMcpOAuthProvider({
          redirectUri,
          store: input.connection.authorization.store,
          state: input.state,
          clientName,
        })
      : undefined
    const transport = new StreamableHTTPClientTransport(serverUrl, {
      authProvider: oauthProvider,
      fetch: observer.fetch,
      requestInit: requestInit(input.connection.authorization),
    })
    const client = new Client({ name: clientName, version: clientVersion }, { capabilities: {} })
    const requestOptions: RequestOptions = {
      signal: controller.signal,
      timeout: operationTimeoutMs,
      maxTotalTimeout: operationTimeoutMs,
      resetTimeoutOnProgress: false,
    }
    return { client, transport, oauthProvider, observer, controller, requestOptions }
  }

  async function runOperation<T>(input: {
    connection: EnterpriseMcpConnection
    redirectUri: string
    state?: string
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
      connectionId: input.connection.id,
      operationPhase: input.operationPhase,
      requestPhase: null,
      outcome: "started",
    })
    const startedAt = Date.now()
    try {
      const result = await input.operation(session)
      emitDiagnostic({
        connectionId: input.connection.id,
        operationPhase: input.operationPhase,
        requestPhase: session.observer.lastRequestPhase(),
        outcome: "succeeded",
        durationMs: Date.now() - startedAt,
      })
      return result
    } catch (error) {
      const wrapped = error instanceof EnterpriseMcpClientError
        ? error
        : new EnterpriseMcpClientError({
            operationPhase: input.operationPhase,
            requestPhase: session.observer.lastRequestPhase(),
            cause: error,
          })
      emitDiagnostic({
        connectionId: input.connection.id,
        operationPhase: input.operationPhase,
        requestPhase: session.observer.lastRequestPhase(),
        outcome: "failed",
        durationMs: Date.now() - startedAt,
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
      operation: async (session) => {
        await session.client.connect(session.transport, session.requestOptions)
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
      return runOperation({
        connection: input.connection,
        redirectUri: input.redirectUri,
        state: input.state,
        operationPhase: "connection-handshake",
        operation: async (session) => {
          try {
            await session.client.connect(session.transport, session.requestOptions)
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
      await runOperation({
        connection: input.connection,
        redirectUri: input.redirectUri,
        operationPhase: "authorization-callback",
        operation: async (session) => {
          let operationFailed = false
          try {
            await session.transport.finishAuth(input.code)
          } catch (error) {
            operationFailed = true
            throw error
          } finally {
            try {
              await closeWithinDeadline(() => session.transport.close(), closeTimeoutMs)
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

    async listTools(input: EnterpriseMcpListToolsInput) {
      return runConnectedOperation({
        connection: input.connection,
        redirectUri: input.redirectUri,
        operationPhase: "tool-discovery",
        operation: async (session) => {
          const result = await session.client.listTools(undefined, session.requestOptions)
          return result.tools
        },
      })
    },

    async callTool(input: EnterpriseMcpCallToolInput) {
      toolNameSchema.parse(input.toolName)
      return runConnectedOperation({
        connection: input.connection,
        redirectUri: input.redirectUri,
        operationPhase: "tool-execution",
        operation: async (session) => {
          const result = await session.client.callTool({
            name: input.toolName,
            arguments: input.arguments,
          }, undefined, session.requestOptions)
          if ("isError" in result && result.isError) throw new EnterpriseMcpToolResultError()
          return result
        },
      })
    },
  }
}
