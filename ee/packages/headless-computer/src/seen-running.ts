import type { RunSpec, SandboxHandle, SandboxProvider } from "@openwork/sandbox"

/**
 * How long a computer the provider showed running is taken to still be running, and a desktop found current to still
 * be current. Calls a few seconds apart then ask neither again; anything further apart asks as before.
 */
export const SEEN_MS = 15_000

const REFUSED_WITHIN_MS = 5_000

const DESKTOP_CALL = /openwork-desktop-bridge call /

type Guess = { sessionId: string; ended: number }

const keyOf = (box: SandboxHandle) => JSON.stringify(box.ref)

/**
 * What this process saw of each computer moments ago: that it was running, and that its desktop was current. Anything
 * that fails on a computer, pauses it, stops it or removes it forgets both, so the next call asks again.
 */
export class SeenRunning {
  private readonly seen = new Map<string, { at: number; desktopAt?: number }>()
  private readonly ended = new Map<string, number>()
  private readonly guesses = new WeakMap<SandboxHandle, Guess>()

  running(box: SandboxHandle) {
    const entry = this.seen.get(keyOf(box))
    return entry !== undefined && Date.now() - entry.at < SEEN_MS
  }

  desktopCurrent(box: SandboxHandle) {
    const at = this.seen.get(keyOf(box))?.desktopAt
    return at !== undefined && Date.now() - at < SEEN_MS && this.running(box)
  }

  desktop(box: SandboxHandle, current: boolean) {
    const entry = this.seen.get(keyOf(box))
    if (!entry) return
    if (current) entry.desktopAt = Date.now()
    else delete entry.desktopAt
  }

  observe<T extends SandboxHandle | null>(box: T): T {
    if (box?.state === "running") this.seen.set(keyOf(box), { ...this.seen.get(keyOf(box)), at: box.observedAt })
    else if (box) this.forget(box)
    return box
  }

  ran(box: SandboxHandle) {
    const entry = this.seen.get(keyOf(box))
    if (entry) entry.at = Date.now()
  }

  forget(box: SandboxHandle) {
    this.seen.delete(keyOf(box))
  }

  end(box: SandboxHandle) {
    this.forget(box)
    this.ended.set(keyOf(box), (this.ended.get(keyOf(box)) ?? 0) + 1)
  }

  guess(box: SandboxHandle, sessionId: string): SandboxHandle {
    const copy = { ...box }
    this.guesses.set(copy, { sessionId, ended: this.ended.get(keyOf(box)) ?? 0 })
    return copy
  }

  take(box: SandboxHandle) {
    const guess = this.guesses.get(box)
    this.guesses.delete(box)
    return guess
  }

  stands(box: SandboxHandle, guess: Guess) {
    return guess.ended === (this.ended.get(keyOf(box)) ?? 0)
  }
}

/**
 * The provider with what each call shows of a computer kept in `seen`. The first call on a computer that was only
 * taken to be running (`SeenRunning.guess`) is run once more, on the computer `afterWrongGuess` returns, when it was
 * refused and this process did not pause or remove the computer itself.
 */
export function watchedProvider(
  provider: SandboxProvider,
  seen: SeenRunning,
  afterWrongGuess: (sessionId: string, box: SandboxHandle, error: unknown) => Promise<SandboxHandle | null>,
): SandboxProvider {
  async function on<T>(box: SandboxHandle, call: (box: SandboxHandle) => Promise<T>): Promise<T> {
    const guess = seen.take(box)
    const started = Date.now()
    try { return await call(box) }
    catch (error) {
      seen.forget(box)
      const refused = guess && seen.stands(box, guess) && Date.now() - started < REFUSED_WITHIN_MS
      const again = refused ? await afterWrongGuess(guess.sessionId, box, error) : null
      if (!again) throw error
      return call(again)
    }
  }
  async function ending(box: SandboxHandle, call: () => Promise<void>) {
    seen.end(box)
    try { await call() }
    finally { seen.forget(box) }
  }
  const blocks = provider.blocks
  const run = blocks?.run
  const files = blocks?.files
  const pause = blocks?.pause
  return {
    ...provider,
    describe: () => provider.describe(),
    currentImage: () => provider.currentImage(),
    create: async (spec, opts) => seen.observe(await provider.create(spec, opts)),
    find: async query => seen.observe(await provider.find(query)),
    inspect: async box => seen.observe(await provider.inspect(box)),
    stop: (box, opts) => ending(box, () => provider.stop(box, opts)),
    destroy: (box, opts) => ending(box, () => provider.destroy(box, opts)),
    endpoint: (box, port, opts) => on(box, box => provider.endpoint(box, port, opts)),
    ...(blocks ? {
      blocks: {
        ...blocks,
        ...(run ? {
          run: async (box: SandboxHandle, spec: RunSpec) => {
            const result = await on(box, box => run(box, spec))
            seen.ran(box)
            if (result.exitCode !== 0 && DESKTOP_CALL.test(spec.command)) seen.desktop(box, false)
            return result
          },
        } : {}),
        ...(files ? {
          files: {
            read: (box, path, opts) => on(box, box => files.read(box, path, opts)),
            write: (box, path, bytes, opts) => on(box, box => files.write(box, path, bytes, opts)),
            stat: (box, path, opts) => on(box, box => files.stat(box, path, opts)),
          },
        } : {}),
        ...(pause ? { pause: (box: SandboxHandle, opts: { timeoutMs: number }) => ending(box, () => pause(box, opts)) } : {}),
      },
    } : {}),
  }
}
