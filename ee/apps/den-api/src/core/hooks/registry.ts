import { alwaysOnModuleStateSource, type CoreHookModuleStateSource } from "./module-state.js"
import type {
  CoreGuardPointName,
  CoreGuardPoints,
  CoreParticipantPointName,
  CoreParticipantPoints,
  CorePostCommitPointName,
  CorePostCommitPoints,
  CoreTxPointName,
  CoreTxPoints,
} from "./points.js"
import { compareCoreHookRegistrations, coreHookScope, shouldRunCoreHook } from "./run.js"
import {
  CORE_HOOK_ORDER,
  type CoreHookErrorPolicy,
  type CoreHookInputBase,
  type CoreHookRegistrationBase,
  type CoreHookRejection,
} from "./types.js"

export interface CoreGuardRegistration<P extends CoreGuardPointName> extends CoreHookRegistrationBase<P> {
  // Return a rejection to stop the chain. A thrown error fails closed.
  handler: (input: CoreGuardPoints[P]) => Promise<CoreHookRejection | null>
}

export interface CoreTxRegistration<P extends CoreTxPointName> extends CoreHookRegistrationBase<P> {
  // Runs inside the caller's transaction; a thrown error rolls it back.
  handler: (input: CoreTxPoints[P]) => Promise<void>
}

export interface CoreParticipantRegistration<P extends CoreParticipantPointName> extends CoreHookRegistrationBase<P> {
  handler: <T>(input: CoreParticipantPoints[P], next: () => Promise<T>) => Promise<T>
}

export interface CorePostCommitRegistration<P extends CorePostCommitPointName> extends CoreHookRegistrationBase<P> {
  // Default "isolate". Ignored for security hooks, which retry and never fail the request.
  errorPolicy?: CoreHookErrorPolicy
  handler: (input: CorePostCommitPoints[P]) => Promise<void>
}

type GuardStore = { [K in CoreGuardPointName]: CoreGuardRegistration<K>[] }
type TxStore = { [K in CoreTxPointName]: CoreTxRegistration<K>[] }
type ParticipantStore = { [K in CoreParticipantPointName]: CoreParticipantRegistration<K>[] }
type PostCommitStore = { [K in CorePostCommitPointName]: CorePostCommitRegistration<K>[] }

// One entry per point: adding a point to points.ts without listing it here
// fails typecheck, so the runtime catalogue cannot drift from the types.
function emptyGuardStore(): GuardStore {
  return {
    "member.removalGuard": [],
    "invitation.createGuard": [],
    "invitation.cancelGuard": [],
    "team.mutationGuard": [],
    "org.deletion.pre": [],
  }
}

function emptyTxStore(): TxStore {
  return {
    "member.removing": [],
    "invitation.accepted": [],
    "team.membershipChanged": [],
    "team.deleting": [],
    "org.deletion.purge": [],
    "user.deleting": [],
  }
}

function emptyParticipantStore(): ParticipantStore {
  return {
    "membership.mutation.participant": [],
  }
}

function emptyPostCommitStore(): PostCommitStore {
  return {
    "member.added": [],
    "member.removed": [],
    "member.roleChanged": [],
    "org.created": [],
    "org.deletion.post": [],
    "module.enabledForOrg": [],
  }
}

type LogFields = Readonly<Record<string, unknown>>

export interface CoreHookLogger {
  info: (message: string, fields?: LogFields) => void
  warn: (message: string, fields?: LogFields) => void
  error: (message: string, fields?: LogFields) => void
}

export interface CoreHookRegistryOptions {
  logger?: CoreHookLogger
  reportError?: (error: unknown, fields: LogFields) => void
  sleep?: (ms: number) => Promise<void>
  // Waits between attempts of a failing post-commit security hook.
  securityRetryDelaysMs?: readonly number[]
}

const DEFAULT_SECURITY_RETRY_DELAYS_MS = [250, 1_000, 4_000]

const silentLogger: CoreHookLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function sortRegistrations<R extends Pick<CoreHookRegistrationBase<string>, "id" | "order">>(list: R[]) {
  list.sort((left, right) => compareCoreHookRegistrations(left, right, CORE_HOOK_ORDER.default))
}

function errorFields(error: unknown) {
  return error instanceof Error ? { error_name: error.name, error_message: error.message } : { error_message: String(error) }
}

export type CoreHookRegistry = ReturnType<typeof createCoreHookRegistry>

export function createCoreHookRegistry(options: CoreHookRegistryOptions = {}) {
  const logger = options.logger ?? silentLogger
  const sleep = options.sleep ?? defaultSleep
  const securityRetryDelaysMs = options.securityRetryDelaysMs ?? DEFAULT_SECURITY_RETRY_DELAYS_MS

  const guards = emptyGuardStore()
  const txHooks = emptyTxStore()
  const participants = emptyParticipantStore()
  const postCommits = emptyPostCommitStore()
  const ids = new Map<string, string>()
  let frozen = false
  let moduleStateSource: CoreHookModuleStateSource = alwaysOnModuleStateSource

  function claim(registration: CoreHookRegistrationBase<string>) {
    if (frozen) {
      throw new Error(`core_hooks_frozen: cannot register ${registration.id} on ${registration.point} after freezeCoreHooks()`)
    }
    const existing = ids.get(registration.id)
    if (existing !== undefined) {
      throw new Error(`core_hook_duplicate_id: ${registration.id} is already registered on ${existing}`)
    }
    if (registration.id.trim().length === 0) {
      throw new Error(`core_hook_invalid_id: empty id on ${registration.point}`)
    }
    ids.set(registration.id, registration.point)
  }

  async function shouldRun(
    registration: CoreHookRegistrationBase<string>,
    input: CoreHookInputBase,
  ) {
    const run = await shouldRunCoreHook(registration, coreHookScope(input), moduleStateSource)
    if (!run) {
      logger.info("core_hook_skipped", {
        point: registration.point,
        hook_id: registration.id,
        module_id: registration.moduleId,
        organization_id: input.organizationId ?? undefined,
      })
    }
    return run
  }

  function dispatchStarted() {
    // The first dispatch fixes the set of hooks; later registration is a bug.
    frozen = true
  }

  async function runSecurityPostCommit<P extends CorePostCommitPointName>(
    registration: CorePostCommitRegistration<P>,
    input: CorePostCommitPoints[P],
  ) {
    let lastError: unknown = null
    for (let attempt = 0; attempt <= securityRetryDelaysMs.length; attempt += 1) {
      if (attempt > 0) {
        await sleep(securityRetryDelaysMs[attempt - 1] ?? 0)
      }
      try {
        await registration.handler(input)
        return
      } catch (error) {
        lastError = error
      }
    }
    const fields = {
      point: registration.point,
      hook_id: registration.id,
      organization_id: input.organizationId ?? undefined,
      attempts: securityRetryDelaysMs.length + 1,
      ...errorFields(lastError),
    }
    logger.error("core_hook_security_failure", fields)
    options.reportError?.(lastError, fields)
  }

  return {
    registerGuard<P extends CoreGuardPointName>(registration: CoreGuardRegistration<P>) {
      claim(registration)
      const list: CoreGuardRegistration<P>[] = guards[registration.point]
      list.push(registration)
      sortRegistrations(list)
    },

    registerTx<P extends CoreTxPointName>(registration: CoreTxRegistration<P>) {
      claim(registration)
      const list: CoreTxRegistration<P>[] = txHooks[registration.point]
      list.push(registration)
      sortRegistrations(list)
    },

    registerParticipant<P extends CoreParticipantPointName>(registration: CoreParticipantRegistration<P>) {
      claim(registration)
      const list: CoreParticipantRegistration<P>[] = participants[registration.point]
      list.push(registration)
      sortRegistrations(list)
    },

    registerPostCommit<P extends CorePostCommitPointName>(registration: CorePostCommitRegistration<P>) {
      claim(registration)
      const list: CorePostCommitRegistration<P>[] = postCommits[registration.point]
      list.push(registration)
      sortRegistrations(list)
    },

    setModuleStateSource(source: CoreHookModuleStateSource) {
      moduleStateSource = source
    },

    freeze() {
      frozen = true
    },

    isFrozen() {
      return frozen
    },

    // point → ordered hook ids, for the boot log line and the snapshot test.
    describe() {
      const description: Record<string, string[]> = {}
      const stores: Array<Record<string, ReadonlyArray<{ id: string }> | undefined>> = [guards, txHooks, participants, postCommits]
      for (const store of stores) {
        for (const [point, list] of Object.entries(store)) {
          if (list && list.length > 0) description[point] = list.map((registration) => registration.id)
        }
      }
      return Object.fromEntries(Object.entries(description).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
    },

    // First rejection wins. Thrown errors propagate (the request fails closed).
    async runGuards<P extends CoreGuardPointName>(point: P, input: CoreGuardPoints[P]): Promise<CoreHookRejection | null> {
      dispatchStarted()
      for (const registration of guards[point]) {
        if (!(await shouldRun(registration, input))) continue
        const rejection = await registration.handler(input)
        if (rejection) return rejection
      }
      return null
    },

    // Sequential inside the caller's transaction. Errors roll the transaction back.
    async runTx<P extends CoreTxPointName>(point: P, input: CoreTxPoints[P]): Promise<void> {
      dispatchStarted()
      for (const registration of txHooks[point]) {
        if (!(await shouldRun(registration, input))) continue
        await registration.handler(input)
      }
    },

    // Wraps `body` in every participant, lowest order outermost.
    async runParticipants<P extends CoreParticipantPointName, T>(point: P, input: CoreParticipantPoints[P], body: () => Promise<T>): Promise<T> {
      dispatchStarted()
      const active: CoreParticipantRegistration<P>[] = []
      for (const registration of participants[point]) {
        if (await shouldRun(registration, input)) active.push(registration)
      }
      let next = body
      for (const registration of active.reverse()) {
        const inner = next
        next = () => registration.handler(input, inner)
      }
      return next()
    },

    // Sequential after commit. Security hooks retry and never fail the
    // request; "isolate" hooks log and continue; a "propagate" failure skips
    // the remaining non-security hooks and is rethrown at the end.
    async runPostCommit<P extends CorePostCommitPointName>(point: P, input: CorePostCommitPoints[P]): Promise<void> {
      dispatchStarted()
      let propagated: { error: unknown } | null = null
      for (const registration of postCommits[point]) {
        if (propagated && registration.security !== true) continue
        if (!(await shouldRun(registration, input))) continue
        if (registration.security === true) {
          await runSecurityPostCommit(registration, input)
          continue
        }
        try {
          await registration.handler(input)
        } catch (error) {
          if ((registration.errorPolicy ?? "isolate") === "propagate") {
            propagated = { error }
            continue
          }
          logger.warn("core_hook_failure", {
            point,
            hook_id: registration.id,
            organization_id: input.organizationId ?? undefined,
            ...errorFields(error),
          })
        }
      }
      if (propagated) throw propagated.error
    },
  }
}
