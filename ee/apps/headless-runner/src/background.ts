/**
 * Storage upkeep that runs with no request: sealing old turns into segments, flushing the Den index outbox, splitting
 * an owner cell into session cells, orphan cleanup. Each job says when it is next due; the host runs due jobs on its
 * own schedule (a timer on Node, the cell's durable alarm on celld, alongside step-mode steps and self-resume).
 *
 * A job's failure stays with that job: it is reported by code and retried at the job's next due time, never stopping
 * the other jobs, the alarm or the cell.
 */
export type BackgroundJob = {
  /** Short stable name, used in logs and error reports (never content). */
  name: string
  /** When the job next has work, in epoch ms, or null when it has none. Must be cheap and must not throw. */
  nextAt(): number | null
  /** Does the work that is due now. May throw; the failure is contained here. */
  run(): Promise<void>
}

export type BackgroundFailure = (job: string, error: unknown) => void | Promise<void>

export class BackgroundJobs {
  private readonly jobs: BackgroundJob[] = []
  private running: Promise<void> | null = null

  constructor(private readonly onFailure: BackgroundFailure = () => undefined) {}

  /** Adds a job; names must be unique. */
  register(job: BackgroundJob) {
    if (this.jobs.some((existing) => existing.name === job.name)) throw new Error(`background_job_exists:${job.name}`)
    this.jobs.push(job)
  }

  /** The earliest due time of any job, or null when none has work. Never throws. */
  nextAt(): number | null {
    let earliest: number | null = null
    for (const job of this.jobs) {
      let at: number | null
      try {
        at = job.nextAt()
      } catch {
        at = null
      }
      if (at !== null && Number.isFinite(at) && (earliest === null || at < earliest)) earliest = at
    }
    return earliest
  }

  /**
   * Runs every job that is due now, one after another (they share the cell's single SQLite). Never throws. A call
   * while a previous run is still going waits for that run instead of starting a second one.
   */
  runDue(now: () => number = Date.now): Promise<void> {
    if (this.running) return this.running
    this.running = (async () => {
      for (const job of this.jobs) {
        let at: number | null
        try {
          at = job.nextAt()
        } catch (error) {
          await this.fail(job.name, error)
          continue
        }
        if (at === null || at > now()) continue
        try {
          await job.run()
        } catch (error) {
          await this.fail(job.name, error)
        }
      }
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async fail(job: string, error: unknown) {
    console.error("[headless-runner] background job failed", { job, error: error instanceof Error ? error.message : "unknown" })
    try {
      await this.onFailure(job, error)
    } catch {
      // Reporting is best effort.
    }
  }
}
