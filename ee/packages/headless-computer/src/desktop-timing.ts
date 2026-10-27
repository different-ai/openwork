import type { RunSpec, SandboxHandle, SandboxProvider } from "@openwork/sandbox"

type Step = { ms: number; count: number }

/** What one bridge command asked the guest, from its command line; never the command or its payload. */
function bridgeStep(command: string) {
  if (/openwork-desktop-bridge start /.test(command)) return "desktop_start"
  const path = /openwork-desktop-bridge call '?\/([a-z/]+)/.exec(command)?.[1]
  return path ? path.replaceAll("/", "_") : "command"
}

/**
 * The steps of one desktop request (opening the view, resuming, a tool's first desktop use), written to the runner
 * log as one line when it ends, so a slow computer shows where the time went. Only step names, counts and durations.
 */
export class DesktopTiming {
  private readonly started = performance.now()
  private readonly steps: Record<string, Step> = {}
  /** The VM's state when the request first looked it up: `stopped` is paused, `missing` means a new computer. */
  before?: string

  constructor(readonly sessionId: string, readonly operation: string) {}

  add(name: string, ms: number) {
    const step = this.steps[name] ??= { ms: 0, count: 0 }
    step.ms += ms
    step.count++
  }

  /** Whether the request woke, created or started anything, rather than finding the desktop ready. */
  get prepared() {
    return ["vm_start", "vm_create", "desktop_start"].some(name => name in this.steps)
  }

  log(outcome: string) {
    const steps = Object.fromEntries(Object.entries(this.steps).map(([name, step]) => [name, { ms: Math.round(step.ms), count: step.count }]))
    console.log(`[headless-computer] desktop timing ${JSON.stringify({ sessionId: this.sessionId, operation: this.operation, outcome, totalMs: Math.round(performance.now() - this.started), before: this.before ?? null, steps })}`)
  }
}

/**
 * The provider with each VM call and bridge command added to the timing open for that VM, found by the VM's slug
 * (every provider names its handles by it). Calls with no open timing pass straight through.
 */
export function timedProvider(provider: SandboxProvider, timingFor: (key: string) => DesktopTiming | undefined): SandboxProvider {
  const keyOf = (handle: SandboxHandle) => timingFor(handle.name ?? "")
  async function timed<T>(timing: DesktopTiming | undefined, name: string, fn: () => Promise<T>): Promise<T> {
    if (!timing) return fn()
    const started = performance.now()
    try { return await fn() }
    finally { timing.add(name, performance.now() - started) }
  }
  const seen = <T extends SandboxHandle | null>(timing: DesktopTiming | undefined, handle: T) => {
    if (timing) timing.before ??= handle?.state ?? "missing"
    return handle
  }
  const blocks = provider.blocks
  const run = blocks?.run
  return {
    ...provider,
    describe: () => provider.describe(),
    currentImage: () => provider.currentImage(),
    find: async query => { const timing = timingFor(query.idempotencyKey ?? ""); return seen(timing, await timed(timing, "vm_lookup", () => provider.find(query))) },
    inspect: async handle => { const timing = keyOf(handle); return seen(timing, await timed(timing, "vm_lookup", () => provider.inspect(handle))) },
    create: (spec, opts) => timed(timingFor(spec.idempotencyKey), "vm_create", () => provider.create(spec, opts)),
    start: (handle, opts) => timed(keyOf(handle), "vm_start", () => provider.start(handle, opts)),
    endpoint: (handle, port, opts) => timed(keyOf(handle), "endpoint", () => provider.endpoint(handle, port, opts)),
    ...(blocks ? { blocks: { ...blocks, ...(run ? { run: (handle: SandboxHandle, spec: RunSpec) => timed(keyOf(handle), bridgeStep(spec.command), () => run(handle, spec)) } : {}) } } : {}),
  }
}
