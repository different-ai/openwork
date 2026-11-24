import type { ComputerSide } from "./store.js"
import type { SessionComputer } from "./types.js"

export type ComputerSideApi = SessionComputer & {
  start?(sessionId: string): Promise<void>
  has?(sessionId: string): Promise<boolean>
  pauseIdle?(sessionId: string): Promise<void>
}

type Log = (message: string, detail: Record<string, unknown>) => void

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

  const route = async (sessionId: string, create: boolean): Promise<ComputerSideApi | undefined> => {
    if (!input.viaGateway(sessionId) || !gateway || !direct) return current(sessionId)
    const recorded = sides.get(sessionId)
    if (recorded === "gateway") return gateway
    if (recorded === "direct") {
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
  return {
    prompt: any.prompt,
    tools: any.tools,
    toolNames: any.toolNames,
    image: any.image,
    ...(any.desktopTools ? { desktopTools: any.desktopTools } : {}),
    available: (sessionId) => (input.viaGateway(sessionId) ? gateway ?? direct : direct) !== undefined,
    desktopRun: async (sessionId, args, signal, policy) => (await desktop(sessionId, true)).desktopRun(sessionId, args, signal, policy),
    desktopViewer: async (sessionId, view) => (await desktop(sessionId, false)).desktopViewer(sessionId, view),
    browserDemonstration: async (sessionId, command) => (await desktop(sessionId, true)).browserDemonstration(sessionId, command),
    desktopAction: async (sessionId, action) => (await desktop(sessionId, false)).desktopAction(sessionId, action),
    run: async (sessionId, name, args, callKey) => (await routed(sessionId, true)).run(sessionId, name, args, callKey),
    pickUp: async (sessionId, name, args, callKey) => (await (await route(sessionId, false))?.pickUp?.(sessionId, name, args, callKey)) ?? null,
    known: (sessionId) => current(sessionId)?.known(sessionId) ?? false,
    prewarm: (sessionId) => void route(sessionId, true).then((computer) => computer?.prewarm(sessionId)).catch(() => undefined),
    release: (sessionId) => {
      direct?.release(sessionId)
      gateway?.release(sessionId)
    },
    pauseIdle: async (sessionId) => {
      await current(sessionId)?.pauseIdle?.(sessionId)
    },
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
