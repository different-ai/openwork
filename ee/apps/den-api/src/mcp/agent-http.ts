import { AsyncLocalStorage } from "node:async_hooks"
import {
  createMcpHandler,
  type McpHttpHandler,
  type McpServer,
  type ServerEvent,
  type ServerEventBus,
} from "@modelcontextprotocol/server"

export const AGENT_MCP_MAX_REQUEST_BYTES = 48 * 1024 * 1024

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

export type AgentMcpAudience = {
  organizationId: string
  userId: string
}

export type AgentMcpMember = AgentMcpAudience

export type ScopedAgentMcpHttpHandlers = {
  fetch: (audience: AgentMcpAudience, request: Request, server: McpServer) => Promise<Response>
  notify: {
    toolsChanged: (member: AgentMcpMember) => void
    resourcesChanged: (member: AgentMcpMember) => void
  }
  close: () => Promise<void>
}

type Listener = { memberKey: string }
type PublishTarget = { memberKey: string }

function memberKey(member: AgentMcpMember): string {
  return `${member.organizationId}\0${member.userId}`
}

class ScopedAgentMcpEventBus implements ServerEventBus {
  private readonly audience = new AsyncLocalStorage<Listener>()
  private readonly target = new AsyncLocalStorage<PublishTarget>()
  private readonly listeners = new Map<(event: ServerEvent) => void, Listener>()

  constructor(private readonly onerror?: (error: Error) => void) {}

  run<T>(audience: AgentMcpAudience, callback: () => T): T {
    return this.audience.run({ memberKey: memberKey(audience) }, callback)
  }

  publishTo<T>(target: PublishTarget, callback: () => T): T {
    return this.target.run(target, callback)
  }

  publish(event: ServerEvent): void {
    const current = this.audience.getStore()
    const target = this.target.getStore() ?? (current ? { memberKey: current.memberKey } : null)
    if (!target) return
    for (const [listener, audience] of this.listeners) {
      if (audience.memberKey !== target.memberKey) continue
      try {
        listener(event)
      } catch (error) {
        this.reportError(error)
      }
    }
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    const audience = this.audience.getStore()
    if (!audience) throw new Error("Agent MCP subscriptions require an authenticated catalog audience.")
    this.listeners.set(listener, audience)
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
    }
  }
}

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
    maxRequestBodySize: AGENT_MCP_MAX_REQUEST_BYTES,
  })

  const notify: ScopedAgentMcpHttpHandlers["notify"] = {
    toolsChanged(member) {
      bus.publishTo({ memberKey: memberKey(member) }, () => handler.notify.toolsChanged())
    },
    resourcesChanged(member) {
      bus.publishTo({ memberKey: memberKey(member) }, () => handler.notify.resourcesChanged())
    },
  }
  return {
    fetch(audience, request, server) {
      return bus.run(audience, () => requestServer.run(server, () => handler.fetch(request)))
    },
    notify,
    close: () => handler.close(),
  }
}
