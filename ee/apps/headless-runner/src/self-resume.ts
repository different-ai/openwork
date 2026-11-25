import type { HeadlessModelAccess } from "@openwork-ee/headless-protocol"
import type { ResumeExchange, ResumeExchangeResult } from "./den-resume.js"
import type { ErrorReporter } from "./error-reporting.js"
import type { GrantVault } from "./resume-grants.js"
import type { Store } from "./store.js"

export const SELF_RESUMED_ERRORS = ["runner_restarted", "runner_shutdown", "credentials_refresh"] as const

export type FreshCredentials = { mcpToken: string; readOnly: boolean; modelAccess?: HeadlessModelAccess }
export type ResumeSend = (input: { sessionId: string; messageId: string; credentials: FreshCredentials & { resumeGrant: string } }) => { ok: boolean; state?: string }
export type SweepResult = { resumed: number; waiting: number; failed: number }

export type SelfResumeOptions = {
  store: Store
  vault: GrantVault
  exchange: ResumeExchange
  errors?: ErrorReporter
  now?: () => number
  random?: () => number
  backoff?: { baseMs: number; maxMs: number }
}

const DEFAULT_BACKOFF = { baseMs: 30_000, maxMs: 15 * 60_000 }
const GRANT_ENDINGS: ReadonlySet<string> = new Set(["grant_expired", "grant_revoked", "membership_inactive", "feature_disabled"])
const keyOf = (sessionId: string, messageId: string) => `${sessionId}:${messageId}`
const isSelfResumed = (error: string | null) => SELF_RESUMED_ERRORS.some((reason) => reason === error)

export class SelfResume {
  private readonly writes = new Set<Promise<void>>()
  private readonly retries = new Map<string, { attempts: number; nextAt: number }>()
  private configError: string | null = null
  private sweeping: Promise<SweepResult> | null = null

  constructor(private readonly options: SelfResumeOptions) {}

  private now() {
    return (this.options.now ?? Date.now)()
  }

  get usable() {
    return this.configError === null
  }

  remember(sessionId: string, messageId: string, grant: string) {
    const write = this.options.vault
      .seal(grant)
      .then((sealed) => this.options.store.setResumeGrant(sessionId, messageId, sealed))
      .catch((error: unknown) => {
        void this.options.errors?.report({ code: "resume_grant_store_failed", tags: { sessionId, messageId }, error })
      })
      .finally(() => this.writes.delete(write))
    this.writes.add(write)
  }

  async settled() {
    while (this.writes.size) await Promise.all([...this.writes])
  }

  async keptGrant(sessionId: string, messageId: string): Promise<string | null> {
    if (this.configError) return null
    await this.settled()
    const kept = this.options.store.resumeGrantOf(sessionId, messageId)
    if (!kept) return null
    const grant = await this.options.vault.open(kept.sealed)
    if (grant) return grant
    this.options.store.setResumeGrant(sessionId, kept.holder, null)
    void this.options.errors?.report({ code: "resume_grant_unreadable", level: "warning", tags: { sessionId, messageId } })
    return null
  }

  async refresh(sessionId: string, messageId: string, grant: string): Promise<FreshCredentials | null> {
    if (this.configError) return null
    const { store } = this.options
    const modelAccessRequired = store.modelAccessRequired(sessionId, messageId)
    const model = store.getTurn(sessionId, messageId)?.model
    const result = await this.options.exchange({ grant, sessionId, messageId, ...(modelAccessRequired ? { modelAccessRequired: true, ...(model ? { model } : {}) } : {}) })
    if (!result.ok) {
      await this.failed(sessionId, messageId, grant, result, "refresh")
      return null
    }
    if (modelAccessRequired && !result.modelAccess) return null
    this.retries.delete(keyOf(sessionId, messageId))
    return { mcpToken: result.mcpToken, readOnly: result.readOnly, ...(result.modelAccess ? { modelAccess: result.modelAccess } : {}) }
  }

  sweep(send: ResumeSend): Promise<SweepResult> {
    this.sweeping ??= this.runSweep(send).finally(() => {
      this.sweeping = null
    })
    return this.sweeping
  }

  private async runSweep(send: ResumeSend): Promise<SweepResult> {
    const result: SweepResult = { resumed: 0, waiting: 0, failed: 0 }
    const { store, vault } = this.options
    await this.settled()
    for (const turn of store.interruptedTurns(SELF_RESUMED_ERRORS)) {
      if (this.configError) break
      const { sessionId, messageId } = turn
      const kept = store.resumeGrantOf(sessionId, messageId)
      if (!kept) continue
      const retry = this.retries.get(keyOf(sessionId, messageId))
      if (retry && retry.nextAt > this.now()) {
        result.waiting += 1
        continue
      }
      const grant = await vault.open(kept.sealed)
      if (!grant) {
        store.setResumeGrant(sessionId, kept.holder, null)
        void this.options.errors?.report({ code: "resume_grant_unreadable", level: "warning", tags: { sessionId, messageId } })
        continue
      }
      const modelAccessRequired = store.modelAccessRequired(sessionId, messageId)
      const exchanged = await this.options.exchange({ grant, sessionId, messageId, ...(modelAccessRequired ? { modelAccessRequired: true, ...(turn.model ? { model: turn.model } : {}) } : {}) })
      if (!exchanged.ok) {
        result.failed += 1
        await this.failed(sessionId, messageId, grant, exchanged, "sweep")
        if (exchanged.kind === "retryable" && exchanged.code !== "rate_limited") break
        continue
      }
      if (modelAccessRequired && !exchanged.modelAccess) {
        this.backOff(sessionId, messageId)
        result.waiting += 1
        continue
      }
      this.retries.delete(keyOf(sessionId, messageId))
      const current = store.getTurn(sessionId, messageId)
      if (current?.status !== "interrupted" || !isSelfResumed(current.error)) continue
      const sent = send({ sessionId, messageId, credentials: { mcpToken: exchanged.mcpToken, readOnly: exchanged.readOnly, resumeGrant: grant, ...(exchanged.modelAccess ? { modelAccess: exchanged.modelAccess } : {}) } })
      if (sent.ok && sent.state === "resumed") {
        result.resumed += 1
        console.log(`[headless-runner] turn resumed by the runner ${JSON.stringify({ sessionId, messageId, reason: turn.error })}`)
      } else if (!sent.ok) {
        this.backOff(sessionId, messageId)
      }
    }
    return result
  }

  nextSweepAt(): number | null {
    if (this.configError) return null
    const { store } = this.options
    const now = this.now()
    if (store.hasActiveTurns()) return now
    let earliest: number | null = null
    for (const turn of store.interruptedTurns(SELF_RESUMED_ERRORS)) {
      if (!store.resumeGrantOf(turn.sessionId, turn.messageId)) continue
      const at = Math.max(now, this.retries.get(keyOf(turn.sessionId, turn.messageId))?.nextAt ?? now)
      earliest = earliest === null ? at : Math.min(earliest, at)
    }
    return earliest
  }

  private backOff(sessionId: string, messageId: string, retryAfterMs = 0) {
    const key = keyOf(sessionId, messageId)
    const attempts = (this.retries.get(key)?.attempts ?? 0) + 1
    const { baseMs, maxMs } = this.options.backoff ?? DEFAULT_BACKOFF
    const delay = Math.min(maxMs, baseMs * 2 ** (attempts - 1)) * (0.5 + (this.options.random ?? Math.random)() * 0.5)
    this.retries.set(key, { attempts, nextAt: this.now() + Math.max(delay, retryAfterMs) })
  }

  private async failed(sessionId: string, messageId: string, grant: string, result: Exclude<ResumeExchangeResult, { ok: true }>, during: "refresh" | "sweep") {
    const tags = { sessionId, messageId, reason: result.code, status: result.status, during }
    if (result.kind === "config") {
      if (this.configError) return
      this.configError = result.code
      console.error(`[headless-runner] self-resume is off: Den refused the runner ${JSON.stringify({ reason: result.code, status: result.status })}`)
      void this.options.errors?.report({ code: "resume_config_invalid", tags: { reason: result.code, status: result.status } })
      return
    }
    console.warn(`[headless-runner] resume exchange failed ${JSON.stringify(tags)}`)
    if (result.kind === "retryable") {
      if (!this.retries.has(keyOf(sessionId, messageId))) void this.options.errors?.report({ code: "resume_exchange_failed", level: "warning", tags })
      this.backOff(sessionId, messageId, result.retryAfterMs)
      return
    }
    this.retries.delete(keyOf(sessionId, messageId))
    const kept = this.options.store.resumeGrantOf(sessionId, messageId)
    if (kept && (await this.options.vault.open(kept.sealed)) === grant) this.options.store.setResumeGrant(sessionId, kept.holder, null)
    if (!GRANT_ENDINGS.has(result.code)) void this.options.errors?.report({ code: "resume_exchange_failed", tags })
  }
}
