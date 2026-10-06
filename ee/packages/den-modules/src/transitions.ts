import { MODULE_IDS, type ModuleId } from "@openwork/license-contracts/modules"
import type { EffectiveModules, ModuleState } from "@openwork/license-contracts/resolver"
import type { ModuleLogger } from "./logger"

export type TransitionCause = "org_toggle" | "entitlement_refresh" | "observed"

export interface ModuleTransition {
  readonly organizationId: string
  readonly moduleId: ModuleId
  readonly from: ModuleState
  readonly to: ModuleState
  readonly cause: TransitionCause
  readonly observedAt: string
}

export type ModuleTransitionListener = (transition: ModuleTransition) => void | Promise<void>

export interface ModuleStateChange {
  readonly moduleId: ModuleId
  readonly from: ModuleState
  readonly to: ModuleState
}

function sameState(a: ModuleState, b: ModuleState): boolean {
  if (a === b) return true
  if (a.state !== b.state) return false
  if (a.state === "off" && b.state === "off") {
    if (a.reason !== b.reason) return false
    if (a.reason === "requires" && b.reason === "requires") return a.requires === b.requires
    return true
  }
  if (a.state === "restricted" && b.state === "restricted") return a.until === b.until
  return true
}

/** Pure: the modules whose state kind or off reason changed. */
export function diffEffectiveModules(previous: EffectiveModules, next: EffectiveModules): ModuleStateChange[] {
  const changes: ModuleStateChange[] = []
  for (const moduleId of MODULE_IDS) {
    const from = previous.modules[moduleId]
    const to = next.modules[moduleId]
    if (!sameState(from, to)) changes.push({ moduleId, from, to })
  }
  return changes
}

/** `off → on | restricted`: the trigger for W0-P14's enable-for-org reconcile. */
export function becameUsable(from: ModuleState, to: ModuleState): boolean {
  return from.state === "off" && to.state !== "off"
}

const DEDUPE_WINDOW_MS = 60_000
const MAX_DEDUPE_KEYS = 50_000

/**
 * Per-replica listener set. Listeners run on a later macrotask
 * (`setImmediate`), each isolated, so a slow or failing listener never
 * affects the request that observed the change. The same
 * `(org, module, to.state)` is emitted at most once per minute per replica.
 */
export class TransitionDispatcher {
  private readonly listeners = new Set<ModuleTransitionListener>()
  private readonly recent = new Map<string, number>()

  constructor(
    private readonly logger: ModuleLogger,
    private readonly schedule: (task: () => void) => void = (task) => {
      setImmediate(task)
    },
  ) {}

  get listenerCount(): number {
    return this.listeners.size
  }

  subscribe(listener: ModuleTransitionListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(organizationId: string, changes: readonly ModuleStateChange[], cause: TransitionCause, now: Date): void {
    if (changes.length === 0 || this.listeners.size === 0) return
    const nowMs = now.getTime()
    for (const change of changes) {
      const key = `${organizationId}|${change.moduleId}|${change.to.state}`
      const last = this.recent.get(key)
      if (last !== undefined && nowMs - last < DEDUPE_WINDOW_MS) continue
      this.remember(key, nowMs)
      const transition: ModuleTransition = { organizationId, ...change, cause, observedAt: now.toISOString() }
      for (const listener of this.listeners) this.schedule(() => this.run(listener, transition))
    }
  }

  private remember(key: string, nowMs: number): void {
    this.recent.delete(key)
    this.recent.set(key, nowMs)
    while (this.recent.size > MAX_DEDUPE_KEYS) {
      const oldest = this.recent.keys().next()
      if (oldest.done) break
      this.recent.delete(oldest.value)
    }
  }

  private run(listener: ModuleTransitionListener, transition: ModuleTransition): void {
    const fail = (error: unknown) => {
      this.logger.error("den_modules_transition_listener_failed", {
        organizationId: transition.organizationId,
        moduleId: transition.moduleId,
        cause: transition.cause,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    try {
      const result = listener(transition)
      if (result instanceof Promise) result.catch(fail)
    } catch (error) {
      fail(error)
    }
  }
}
