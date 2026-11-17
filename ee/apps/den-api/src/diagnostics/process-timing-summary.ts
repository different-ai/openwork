import type { ProcessTimingReport, ProcessTimingSummary } from "@openwork/types/den/diagnostics"

export type ProcessTimingRun = ProcessTimingReport & { receivedAt: string }

type Sample = { runId: string; seconds: number; outcome: string }

export function timingStatistics(samples: Sample[]) {
  const measured = samples.filter((sample) => sample.outcome !== "skipped")
  const seconds = measured.map((sample) => sample.seconds).sort((a, b) => a - b)
  const middle = Math.floor(seconds.length / 2)
  const lower = seconds[middle - 1]
  const upper = seconds[middle]
  return {
    runCount: new Set(samples.map((sample) => sample.runId)).size,
    medianSeconds: upper === undefined ? null : seconds.length % 2 === 0 && lower !== undefined ? (lower + upper) / 2 : upper,
    p90Seconds: seconds[Math.max(0, Math.ceil(seconds.length * 0.9) - 1)] ?? null,
    failureRate: measured.length ? measured.filter((sample) => sample.outcome === "fail").length / measured.length : null,
  }
}

export function summarizeProcessTimings(runs: ProcessTimingRun[], windowDays: number, reportingEnabled: boolean): ProcessTimingSummary {
  const processes = new Map<string, { process: ProcessTimingReport["process"]; environment: ProcessTimingReport["environment"]; samples: Sample[] }>()
  const steps = new Map<string, { process: ProcessTimingReport["process"]; environment: ProcessTimingReport["environment"]; step: string; samples: Sample[] }>()
  for (const run of runs) {
    const key = `${run.process}:${run.environment}`
    const group = processes.get(key) ?? { process: run.process, environment: run.environment, samples: [] }
    group.samples.push({ runId: run.runId, seconds: run.totalSeconds, outcome: run.outcome })
    processes.set(key, group)
    const perRun = new Map<string, Sample>()
    for (const step of run.steps) {
      const previous = perRun.get(step.step)
      perRun.set(step.step, {
        runId: run.runId,
        seconds: (previous?.seconds ?? 0) + (step.outcome === "skipped" ? 0 : step.seconds),
        outcome: previous?.outcome === "fail" || step.outcome === "fail" ? "fail" : previous?.outcome === "ok" || step.outcome === "ok" ? "ok" : "skipped",
      })
    }
    for (const [step, sample] of perRun) {
      const stepKey = `${key}:${step}`
      const stepGroup = steps.get(stepKey) ?? { process: run.process, environment: run.environment, step, samples: [] }
      stepGroup.samples.push(sample)
      steps.set(stepKey, stepGroup)
    }
  }
  return {
    windowDays,
    reportingEnabled,
    processes: [...processes.values()].map(({ samples, ...group }) => ({ ...group, ...timingStatistics(samples) })),
    steps: [...steps.values()].map(({ samples, ...group }) => ({ ...group, ...timingStatistics(samples) })),
    latestRuns: [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, 50),
  }
}
