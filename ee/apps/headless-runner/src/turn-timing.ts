export const TIMED_STEPS = 24

type ToolTiming = { name: string; ms: number }
type StepTiming = {
  setupMs: number
  waitMs?: number
  modelMs?: number
  firstOutputMs?: number
  tools: ToolTiming[]
  ms: number
}
type OpenStep = { at: number; waitMs?: number; modelAt?: number; modelMs?: number; firstOutputMs?: number; tools: ToolTiming[] }

export class TurnTiming {
  private readonly steps: StepTiming[] = []
  private open: OpenStep | null = null
  private lastEnded: number | null = null

  constructor(private readonly clock: () => number = () => performance.now()) {}

  step() {
    if (this.open) this.stepEnded()
    const at = this.clock()
    this.open = { at, ...(this.lastEnded === null ? {} : { waitMs: at - this.lastEnded }), tools: [] }
  }

  modelStarted() {
    if (this.open) this.open.modelAt = this.clock()
  }

  output() {
    const open = this.open
    if (open?.modelAt !== undefined && open.modelMs === undefined && open.firstOutputMs === undefined) open.firstOutputMs = this.clock() - open.modelAt
  }

  modelEnded() {
    const open = this.open
    if (open?.modelAt !== undefined && open.modelMs === undefined) open.modelMs = this.clock() - open.modelAt
  }

  async tool<T>(name: string, run: () => Promise<T>): Promise<T> {
    const open = this.open
    const at = this.clock()
    try {
      return await run()
    } finally {
      open?.tools.push({ name, ms: this.clock() - at })
    }
  }

  stepEnded() {
    const open = this.open
    if (!open) return
    this.open = null
    const now = this.clock()
    this.lastEnded = now
    const setupMs = (open.modelAt ?? now) - open.at
    this.steps.push({
      setupMs,
      ...(open.waitMs === undefined ? {} : { waitMs: open.waitMs }),
      ...(open.modelMs === undefined ? {} : { modelMs: open.modelMs }),
      ...(open.firstOutputMs === undefined ? {} : { firstOutputMs: open.firstOutputMs }),
      tools: open.tools,
      ms: now - open.at,
    })
  }

  summary() {
    this.stepEnded()
    const sum = (pick: (step: StepTiming) => number) => Math.round(this.steps.reduce((total, step) => total + pick(step), 0))
    const shown = this.steps.slice(-TIMED_STEPS)
    return {
      setupMs: sum((step) => step.setupMs),
      waitMs: sum((step) => step.waitMs ?? 0),
      modelMs: sum((step) => step.modelMs ?? 0),
      toolMs: sum((step) => step.tools.reduce((total, tool) => total + tool.ms, 0)),
      ...(this.steps.length > shown.length ? { omittedSteps: this.steps.length - shown.length } : {}),
      steps: shown.map((step) => ({
        setupMs: Math.round(step.setupMs),
        ...(step.waitMs === undefined ? {} : { waitMs: Math.round(step.waitMs) }),
        ...(step.modelMs === undefined ? {} : { modelMs: Math.round(step.modelMs) }),
        ...(step.firstOutputMs === undefined ? {} : { firstOutputMs: Math.round(step.firstOutputMs) }),
        ...(step.tools.length ? { tools: step.tools.map((tool) => ({ name: tool.name, ms: Math.round(tool.ms) })) } : {}),
        ms: Math.round(step.ms),
      })),
    }
  }
}
