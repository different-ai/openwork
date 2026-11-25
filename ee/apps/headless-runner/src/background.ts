export type BackgroundJob = {
  name: string
  nextAt(): number | null
  run(): Promise<void>
}

export type BackgroundFailure = (job: string, error: unknown) => void | Promise<void>

export class BackgroundJobs {
  private readonly jobs: BackgroundJob[] = []
  private running: Promise<void> | null = null

  constructor(private readonly onFailure: BackgroundFailure = () => undefined) {}

  register(job: BackgroundJob) {
    if (this.jobs.some((existing) => existing.name === job.name)) throw new Error(`background_job_exists:${job.name}`)
    this.jobs.push(job)
  }

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
    }
  }
}
