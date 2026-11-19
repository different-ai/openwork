import { AsyncLocalStorage } from "node:async_hooks"
import {
  createMcpHandler,
  type McpHttpHandler,
  type McpServer,
  type ServerEvent,
  type ServerEventBus,
} from "@modelcontextprotocol/server"
import { onInventoryChanged } from "../inventory-writes.js"

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

/** Whose catalog a request or subscription stream belongs to. */
export type AgentMcpAudience = {
  organizationId: string
  userId: string
  /** The stream lists Connect's full tool view (connect-tool-view.ts). */
  fullTools: boolean
}

export type AgentMcpMember = Pick<AgentMcpAudience, "organizationId" | "userId">

export type ScopedAgentMcpHttpHandlers = {
  /** Serve one request inside a stable, authenticated catalog audience. */
  fetch: (audience: AgentMcpAudience, request: Request, server: McpServer) => Promise<Response>
  /** Publish only to subscription streams in the matching audience. */
  notify: {
    toolsChanged: (member: AgentMcpMember) => void
    resourcesChanged: (member: AgentMcpMember) => void
    /** Every full-view stream in the organization: what its members may use changed. */
    fullToolsChanged: (organizationId: string) => void
  }
  close: () => Promise<void>
}

type Listener = { memberKey: string; organizationId: string; fullTools: boolean }
type PublishTarget = { memberKey: string } | { organizationId: string; fullToolsOnly: true }

function memberKey(member: AgentMcpMember): string {
  return `${member.organizationId}\0${member.userId}`
}

class ScopedAgentMcpEventBus implements ServerEventBus {
  private readonly audience = new AsyncLocalStorage<Listener>()
  private readonly target = new AsyncLocalStorage<PublishTarget>()
  private readonly listeners = new Map<(event: ServerEvent) => void, Listener>()

  constructor(private readonly onerror?: (error: Error) => void) {}

  run<T>(audience: AgentMcpAudience, callback: () => T): T {
    return this.audience.run({ memberKey: memberKey(audience), organizationId: audience.organizationId, fullTools: audience.fullTools }, callback)
  }

  publishTo<T>(target: PublishTarget, callback: () => T): T {
    return this.target.run(target, callback)
  }

  publish(event: ServerEvent): void {
    const current = this.audience.getStore()
    const target = this.target.getStore() ?? (current ? { memberKey: current.memberKey } : null)
    if (!target) return
    for (const [listener, audience] of this.listeners) {
      const matches = "memberKey" in target
        ? audience.memberKey === target.memberKey
        : audience.organizationId === target.organizationId && audience.fullTools
      if (!matches) continue
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
 * captured in that same audience, or, for an organization-wide change, to the
 * organization's full-view listeners. Async-local scoping remains correct when
 * requests for different members execute concurrently.
 *
 * A request in this process that changed what an organization's members may
 * use (inventory-writes.ts) tells that organization's full-view streams their
 * tool list changed.
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

  const notify: ScopedAgentMcpHttpHandlers["notify"] = {
    toolsChanged(member) {
      bus.publishTo({ memberKey: memberKey(member) }, () => handler.notify.toolsChanged())
    },
    resourcesChanged(member) {
      bus.publishTo({ memberKey: memberKey(member) }, () => handler.notify.resourcesChanged())
    },
    fullToolsChanged(organizationId) {
      bus.publishTo({ organizationId, fullToolsOnly: true }, () => handler.notify.toolsChanged())
    },
  }
  const stopInventoryChanges = onInventoryChanged((organizationIds) => {
    for (const organizationId of organizationIds) notify.fullToolsChanged(organizationId)
  })

  return {
    fetch(audience, request, server) {
      return bus.run(audience, () => requestServer.run(server, () => handler.fetch(request)))
    },
    notify,
    async close() {
      stopInventoryChanges()
      await handler.close()
    },
  }
}
