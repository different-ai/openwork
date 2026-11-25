import { AsyncLocalStorage } from "node:async_hooks"
import type { ServerEvent, ServerEventBus } from "@modelcontextprotocol/server"
import { onInventoryChanged } from "../inventory-writes.js"

export type InventoryRevision = (organizationId: string) => Promise<string | null>

export const INVENTORY_REVISION_POLL_MS = 30_000

export class InventoryEventBus implements ServerEventBus {
  private readonly organization = new AsyncLocalStorage<string>()
  private readonly listeners = new Map<(event: ServerEvent) => void, string>()
  private readonly watches = new Map<string, { stop: () => void; check: (announce: boolean) => Promise<void> }>()
  private readonly stopLocalChanges: () => void

  constructor(private readonly options: {
    revision: InventoryRevision
    pollMs?: number
    events: readonly ServerEvent[]
    onerror?: (error: unknown) => void
  }) {
    this.stopLocalChanges = onInventoryChanged((organizationIds) => {
      for (const organizationId of organizationIds) {
        const watch = this.watches.get(organizationId)
        if (!watch) continue
        this.changed(organizationId)
        void watch.check(false)
      }
    })
  }

  run<T>(organizationId: string, callback: () => T): T {
    return this.organization.run(organizationId, callback)
  }

  publish(event: ServerEvent): void {
    const organizationId = this.organization.getStore()
    if (organizationId) this.deliver(organizationId, event)
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    const organizationId = this.organization.getStore()
    if (!organizationId) throw new Error("Inventory change subscriptions require an authenticated organization.")
    this.listeners.set(listener, organizationId)
    if (!this.watches.has(organizationId)) this.watches.set(organizationId, this.watch(organizationId))
    let live = true
    return () => {
      if (!live) return
      live = false
      this.listeners.delete(listener)
      if ([...this.listeners.values()].includes(organizationId)) return
      this.watches.get(organizationId)?.stop()
      this.watches.delete(organizationId)
    }
  }

  close(): void {
    this.stopLocalChanges()
    for (const watch of this.watches.values()) watch.stop()
    this.watches.clear()
    this.listeners.clear()
  }

  private changed(organizationId: string) {
    for (const event of this.options.events) this.deliver(organizationId, event)
  }

  private deliver(organizationId: string, event: ServerEvent) {
    for (const [listener, listenerOrganizationId] of this.listeners) {
      if (listenerOrganizationId !== organizationId) continue
      try {
        listener(event)
      } catch (error) {
        this.options.onerror?.(error)
      }
    }
  }

  private watch(organizationId: string) {
    let last: string | null | undefined
    let stopped = false
    const check = async (announce: boolean) => {
      const current = await this.options.revision(organizationId).catch(() => null)
      if (stopped || current === null) return
      if (announce && last !== undefined && current !== last) this.changed(organizationId)
      last = current
    }
    void check(true)
    const timer = setInterval(() => void check(true), this.options.pollMs ?? INVENTORY_REVISION_POLL_MS)
    timer.unref?.()
    return {
      check,
      stop: () => {
        stopped = true
        clearInterval(timer)
      },
    }
  }
}
