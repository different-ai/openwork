import type { ComputerSide } from "./store.js"
import type { SessionComputer } from "./types.js"

/** One side's computers, with what placing a computer needs (headless-computer's Computers has both). */
export type ComputerSideApi = SessionComputer & {
  /** Starts the conversation's computer here and waits for it. */
  start?(sessionId: string): Promise<void>
  /** Whether the conversation has a computer here, without starting it. */
  has?(sessionId: string): Promise<boolean>
  pauseIdle?(sessionId: string): Promise<void>
}

type Log = (message: string, detail: Record<string, unknown>) => void

/**
 * Whether the sandbox gateway can make computers: a probe answered at most every `ttlMs`, and closed at once by an
 * infrastructure failure until the next probe. Each change is logged once.
 */
export class GatewayHealth {
  private state: { up: boolean; at: number } | null = null
  private probing: Promise<boolean> | null = null

  constructor(
    private readonly probe: () => Promise<{ up: boolean; reason: string }>,
    private readonly options: { ttlMs?: number; now?: () => number; log?: Log } = {},
  ) {}

  async up(): Promise<boolean> {
    const now = (this.options.now ?? Date.now)()
    if (this.state && now - this.state.at < (this.options.ttlMs ?? 30_000)) return this.state.up
    this.probing ??= this.probe()
      .catch((error: unknown) => ({ up: false, reason: error instanceof Error ? error.message : "probe failed" }))
      .then(({ up, reason }) => this.record(up, reason))
      .finally(() => { this.probing = null })
    return this.probing
  }

  /** An infrastructure failure from the gateway: new computers go to the runner's own provider until it recovers. */
  down(error: unknown) {
    this.record(false, error instanceof Error ? error.message : "computer failed to start")
  }

  private record(up: boolean, reason: string) {
    if (this.state?.up !== up) {
      (this.options.log ?? console.warn)(
        up ? "[headless-runner] sandbox gateway healthy; new gateway computers go through it again" : "[headless-runner] sandbox gateway unavailable; new gateway computers use the runner's own provider",
        { reason },
      )
    }
    this.state = { up, at: (this.options.now ?? Date.now)() }
    return up
  }
}

/**
 * Each conversation's computer: through the sandbox gateway when its `sandboxGateway` setting is on, else from the
 * runner's own provider. Conversations without the setting never touch the gateway.
 *
 * A gateway conversation's computer is placed when one is first needed, and where it was made is recorded
 * (`sides`): through the gateway while it is healthy, else, or when starting it there fails for want of
 * infrastructure, on the runner's own provider. The gateway's refusals (quotas, placement policy) are errors, never
 * a reason to go around it. A computer stays where it was made: one on the gateway errors while the gateway is down,
 * and one made on the runner's provider is kept until it is gone, when the next goes through the gateway again.
 */
export function routeComputers(input: {
  direct?: ComputerSideApi
  gateway?: ComputerSideApi
  health?: GatewayHealth
  viaGateway: (sessionId: string) => boolean
  sides: { get(sessionId: string): ComputerSide | null; set(sessionId: string, side: ComputerSide): void; clear(sessionId: string): void }
  infrastructure: (error: unknown) => boolean
  log?: Log
}): (SessionComputer & { pauseIdle(sessionId: string): Promise<void> }) | undefined {
  const { direct, gateway, sides } = input
  const any = direct ?? gateway
  if (!any) return undefined
  const log = input.log ?? console.warn
  const healthy = () => input.health?.up() ?? Promise.resolve(true)
  const warned = new Set<string>()
  const placing = new Map<string, Promise<ComputerSideApi>>()

  /** The side now holding the conversation's computer, as recorded; undefined when no side can have one. */
  const current = (sessionId: string): ComputerSideApi | undefined => {
    if (!input.viaGateway(sessionId)) return direct
    if (!gateway) {
      if (!warned.has(sessionId)) {
        warned.add(sessionId)
        log("[headless-runner] sandbox gateway asked for but SANDBOX_GATEWAY is off; using the runner's own computer provider", { sessionId })
      }
      return direct
    }
    return sides.get(sessionId) === "direct" && direct ? direct : gateway
  }

  /** Where a call goes; `create`: the call may make the conversation's computer, so place it first. */
  const route = async (sessionId: string, create: boolean): Promise<ComputerSideApi | undefined> => {
    // Not a gateway conversation, no gateway, or nothing to fall back to: nothing to choose.
    if (!input.viaGateway(sessionId) || !gateway || !direct) return current(sessionId)
    const recorded = sides.get(sessionId)
    if (recorded === "gateway") return gateway
    if (recorded === "direct") {
      // An earlier fallback keeps its computer while it exists, and while the gateway is still down.
      const kept = direct.known(sessionId) || (await direct.has?.(sessionId).catch(() => true) ?? true)
      if (kept || !(await healthy())) return direct
    }
    if (!create) return (await healthy()) ? gateway : direct
    return place(sessionId)
  }

  const place = (sessionId: string) => {
    let pending = placing.get(sessionId)
    if (!pending) {
      pending = (async (): Promise<ComputerSideApi> => {
        if (await healthy()) {
          try {
            await gateway!.start?.(sessionId)
            sides.set(sessionId, "gateway")
            return gateway!
          } catch (error) {
            if (!input.infrastructure(error)) throw error
            input.health?.down(error)
          }
        }
        sides.set(sessionId, "direct")
        log("[headless-runner] gateway conversation's computer placed on the runner's own provider", { sessionId })
        return direct!
      })().finally(() => placing.delete(sessionId))
      placing.set(sessionId, pending)
    }
    return pending
  }

  const routed = async (sessionId: string, create: boolean) => {
    const computer = await route(sessionId, create)
    if (!computer) throw new Error("This runner has no computer for this conversation")
    return computer
  }
  const desktop = async (sessionId: string, create: boolean) => {
    const computer = await routed(sessionId, create)
    if (!computer.desktopRun || !computer.desktopViewer || !computer.browserDemonstration || !computer.desktopAction) throw new Error("This conversation's computer has no desktop")
    return computer as Required<SessionComputer>
  }
  // Async throughout, so a missing computer is a rejected call the runner already reports, never a thrown one.
  return {
    prompt: any.prompt,
    tools: any.tools,
    toolNames: any.toolNames,
    image: any.image,
    ...(any.desktopTools ? { desktopTools: any.desktopTools } : {}),
    available: (sessionId) => (input.viaGateway(sessionId) ? gateway ?? direct : direct) !== undefined,
    desktopRun: async (sessionId, args, signal) => (await desktop(sessionId, true)).desktopRun(sessionId, args, signal),
    desktopViewer: async (sessionId, view) => (await desktop(sessionId, false)).desktopViewer(sessionId, view),
    browserDemonstration: async (sessionId, command) => (await desktop(sessionId, true)).browserDemonstration(sessionId, command),
    desktopAction: async (sessionId, action) => (await desktop(sessionId, false)).desktopAction(sessionId, action),
    run: async (sessionId, name, args) => (await routed(sessionId, true)).run(sessionId, name, args),
    known: (sessionId) => current(sessionId)?.known(sessionId) ?? false,
    prewarm: (sessionId) => void route(sessionId, true).then((computer) => computer?.prewarm(sessionId)).catch(() => undefined),
    // Both sides: a no-op where the conversation has no computer, and one switched away from still pauses.
    release: (sessionId) => {
      direct?.release(sessionId)
      gateway?.release(sessionId)
    },
    pauseIdle: async (sessionId) => {
      await current(sessionId)?.pauseIdle?.(sessionId)
    },
    // The side holding the conversation's computer must succeed; the other side is cleaned up when it can be.
    delete: async (sessionId) => {
      const own = current(sessionId)
      const other = own === direct ? gateway : direct
      await Promise.all([own?.delete(sessionId), other?.delete(sessionId).catch(() => undefined)])
      sides.clear(sessionId)
    },
    previewSavedFile: async (sessionId, fileId) => {
      await (await route(sessionId, true))?.previewSavedFile(sessionId, fileId)
    },
  }
}
