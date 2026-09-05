import { AsyncLocalStorage } from "node:async_hooks"
import {
  createMcpHandler,
  type McpHttpHandler,
  type McpServer,
  type ServerEvent,
  type ServerEventBus,
} from "@modelcontextprotocol/server"

/** The dual-era, sessionless HTTP entry used by the public agent MCP route. */
export function createAgentMcpHttpHandler(
  serverForRequest: (request: Request) => McpServer,
  onerror?: (error: Error) => void,
): McpHttpHandler {
  return createMcpHandler(({ requestInfo }) => {
    if (!requestInfo) throw new Error("Agent MCP HTTP transport requires request context.")
    return serverForRequest(requestInfo)
  }, {
    legacy: "stateless",
    onerror,
  })
}

export type ScopedAgentMcpHttpHandlers = {
  /** Serve one request inside a stable, authenticated catalog audience. */
  fetch: (scopeKey: string, request: Request, server: McpServer) => Promise<Response>
  /** Publish only to subscription streams in the matching audience. */
  notify: {
    toolsChanged: (scopeKey: string) => void
    resourcesChanged: (scopeKey: string) => void
  }
  close: () => Promise<void>
}

class ScopedAgentMcpEventBus implements ServerEventBus {
  private readonly scope = new AsyncLocalStorage<string>()
  private readonly listeners = new Map<(event: ServerEvent) => void, string>()

  constructor(private readonly onerror?: (error: Error) => void) {}

  run<T>(scopeKey: string, callback: () => T): T {
    return this.scope.run(scopeKey, callback)
  }

  publish(event: ServerEvent): void {
    const scopeKey = this.scope.getStore()
    if (!scopeKey) return
    for (const [listener, listenerScope] of this.listeners) {
      if (listenerScope !== scopeKey) continue
      try {
        listener(event)
      } catch (error) {
        this.reportError(error)
      }
    }
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    const scopeKey = this.scope.getStore()
    if (!scopeKey) throw new Error("Agent MCP subscriptions require an authenticated catalog audience.")
    this.listeners.set(listener, scopeKey)
    let live = true
    return () => {
      if (!live) return
      live = false
      this.listeners.delete(listener)
    }
  }

  private reportError(error: unknown) {
    try {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)))
    } catch {
      // Error reporting must never alter subscription delivery.
    }
  }
}

/**
 * Keep the SDK's subscription bus isolated by authenticated catalog audience.
 *
 * One handler retains the SDK's global subscription bound and shutdown
 * semantics. Its event bus captures the authenticated audience when a listen
 * stream subscribes, then delivers a published catalog event only to listeners
 * captured in that same audience. Async-local scoping remains correct when
 * requests for different members execute concurrently.
 */
export function createScopedAgentMcpHttpHandlers(
  onerror?: (error: Error) => void,
): ScopedAgentMcpHttpHandlers {
  const bus = new ScopedAgentMcpEventBus(onerror)
  const requestServer = new AsyncLocalStorage<McpServer>()
  const handler = createMcpHandler(() => {
    const server = requestServer.getStore()
    if (!server) throw new Error("Agent MCP request server was not prepared.")
    return server
  }, {
    legacy: "stateless",
    onerror,
    bus,
  })

  return {
    fetch(scopeKey, request, server) {
      return bus.run(scopeKey, () => requestServer.run(server, () => handler.fetch(request)))
    },
    notify: {
      toolsChanged(scopeKey) {
        bus.run(scopeKey, () => handler.notify.toolsChanged())
      },
      resourcesChanged(scopeKey) {
        bus.run(scopeKey, () => handler.notify.resourcesChanged())
      },
    },
    close: handler.close,
  }
}
