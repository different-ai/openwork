import type { ResumeExchange, ResumeExchangeResult } from "./den-resume.js"
import type { ErrorReporter } from "./error-reporting.js"
import type { GrantVault } from "./resume-grants.js"
import type { Store } from "./store.js"

/**
 * Turns that keep going on their own. A caller that sends a turn with a resume grant (Den mints one per turn when
 * `headlessDurableTurns` is on) lets the runner:
 *
 * - refresh the turn's MCP token in place when it would otherwise pause for `credentials_refresh`, and
 * - resume the turn itself when it was cut off (`runner_restarted`, `runner_shutdown`) or paused anyway.
 *
 * Both exchange the grant with Den for a fresh token for that exact turn. Grants are kept encrypted
 * (resume-grants.ts); a task or report uses the grant of the turn that started it. A grant Den refuses for good is
 * forgotten, so the turn stays `interrupted` and its caller resumes it as before. Nothing here logs or reports a
 * grant or a token: only codes and ids.
 */

/** Why a turn stopped, for the turns the runner resumes itself. */
export const SELF_RESUMED_ERRORS = ["runner_restarted", "runner_shutdown", "credentials_refresh"] as const

export type FreshCredentials = { mcpToken: string; readOnly: boolean }
/** What the sweep needs from the runner: the caller's own re-send. */
export type ResumeSend = (input: { sessionId: string; messageId: string; credentials: FreshCredentials & { resumeGrant: string } }) => { ok: boolean; state?: string }
export type SweepResult = { resumed: number; waiting: number; failed: number }

export type SelfResumeOptions = {
  store: Store
  vault: GrantVault
  exchange: ResumeExchange
  errors?: ErrorReporter
  now?: () => number
  /** Jitter for retries; tests pass a fixed one. */
  random?: () => number
  /** Retries after Den was busy or unreachable wait this long, doubling up to `maxMs`, less up to half at random. */
  backoff?: { baseMs: number; maxMs: number }
}

const DEFAULT_BACKOFF = { baseMs: 30_000, maxMs: 15 * 60_000 }
const GRANT_ENDINGS: ReadonlySet<string> = new Set(["grant_expired", "grant_revoked", "membership_inactive", "feature_disabled"])
const keyOf = (sessionId: string, messageId: string) => `${sessionId}:${messageId}`
const isSelfResumed = (error: string | null) => SELF_RESUMED_ERRORS.some((reason) => reason === error)

export class SelfResume {
  private readonly writes = new Set<Promise<void>>()
  private readonly retries = new Map<string, { attempts: number; nextAt: number }>()
  /** Den refused the runner itself (callback token, endpoint): nothing is exchanged again until a restart. */
  private configError: string | null = null
  private sweeping: Promise<SweepResult> | null = null

  constructor(private readonly options: SelfResumeOptions) {}

  private now() {
    return (this.options.now ?? Date.now)()
  }

  /** Whether Den accepts this runner at all; false after a 401 or 404 from the exchange. */
  get usable() {
    return this.configError === null
  }

  /** Keeps the grant a caller sent with a turn, encrypted, so the turn can be resumed after a restart. */
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

  /** Resolves once every grant received so far is written. */
  async settled() {
    while (this.writes.size) await Promise.all([...this.writes])
  }

  /** A fresh token for a running turn (in place of pausing it), or null when Den won't give one now. */
  async refresh(sessionId: string, messageId: string, grant: string): Promise<FreshCredentials | null> {
    if (this.configError) return null
    const result = await this.options.exchange({ grant, sessionId, messageId })
    if (!result.ok) {
      await this.failed(sessionId, messageId, grant, result, "refresh")
      return null
    }
    this.retries.delete(keyOf(sessionId, messageId))
    return { mcpToken: result.mcpToken, readOnly: result.readOnly }
  }

  /**
   * Resumes every interrupted turn that has a grant and isn't waiting to retry, oldest first, the way its caller
   * would: the same messageId with a fresh token. One sweep at a time; a second call joins the running one.
   */
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
        // Sealed with another key, or damaged: no grant, so the turn waits for its caller.
        store.setResumeGrant(sessionId, kept.holder, null)
        void this.options.errors?.report({ code: "resume_grant_unreadable", level: "warning", tags: { sessionId, messageId } })
        continue
      }
      const exchanged = await this.options.exchange({ grant, sessionId, messageId })
      if (!exchanged.ok) {
        result.failed += 1
        await this.failed(sessionId, messageId, grant, exchanged, "sweep")
        // Den is down: the other turns would wait on it too, so they go on the next sweep.
        if (exchanged.kind === "retryable" && exchanged.code !== "rate_limited") break
        continue
      }
      this.retries.delete(keyOf(sessionId, messageId))
      // A caller may have resumed or stopped it while Den answered; only a turn still waiting is resumed.
      const current = store.getTurn(sessionId, messageId)
      if (current?.status !== "interrupted" || !isSelfResumed(current.error)) continue
      const sent = send({ sessionId, messageId, credentials: { mcpToken: exchanged.mcpToken, readOnly: exchanged.readOnly, resumeGrant: grant } })
      if (sent.ok && sent.state === "resumed") {
        result.resumed += 1
        console.log(`[headless-runner] turn resumed by the runner ${JSON.stringify({ sessionId, messageId, reason: turn.error })}`)
      } else if (!sent.ok) {
        // Too many messages queued in that conversation: try again later.
        this.backOff(sessionId, messageId)
      }
    }
    return result
  }

  /**
   * When a host should sweep next: now-ish while turns run or wait (a crash or a pause would need one), at the
   * earliest retry while every waiting turn backs off, or null when nothing could need it.
   */
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
      // Reported once per turn, not on every retry.
      if (!this.retries.has(keyOf(sessionId, messageId))) void this.options.errors?.report({ code: "resume_exchange_failed", level: "warning", tags })
      this.backOff(sessionId, messageId, result.retryAfterMs)
      return
    }
    // Refused for good: forget the grant (when it is the one kept), so nothing tries it again, even after a restart.
    this.retries.delete(keyOf(sessionId, messageId))
    const kept = this.options.store.resumeGrantOf(sessionId, messageId)
    if (kept && (await this.options.vault.open(kept.sealed)) === grant) this.options.store.setResumeGrant(sessionId, kept.holder, null)
    // Expired, revoked, a member who left or the feature turned off are how grants end (logged above); anything else
    // (an unknown or mismatched grant, a refused request) is a bug worth a report.
    if (!GRANT_ENDINGS.has(result.code)) void this.options.errors?.report({ code: "resume_exchange_failed", tags })
  }
}
