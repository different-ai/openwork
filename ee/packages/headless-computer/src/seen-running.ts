import type { RunSpec, SandboxHandle, SandboxProvider } from "@openwork/sandbox"

/**
 * How long a computer the provider showed running is taken to still be running, and a desktop found current to still
 * be current. Calls a few seconds apart then ask neither again; anything further apart asks as before.
 */
export const SEEN_MS = 15_000

/**
 * A paused or removed computer refuses a call at once. One that fails later than this had started, so its outcome is
 * unknown and it is not run again.
 */
const REFUSED_WITHIN_MS = 5_000

/** A desktop operation sent through the guest's helper (desktop.ts `call`), as opposed to a person's command. */
const DESKTOP_CALL = /openwork-desktop-bridge call /

type Guess = { sessionId: string; ended: number }

const keyOf = (box: SandboxHandle) => JSON.stringify(box.ref)

/**
 * What this process saw of each computer moments ago: that it was running, and that its desktop was current. Anything
 * that fails on a computer, pauses it, stops it or removes it forgets both, so the next call asks again.
 */
export class SeenRunning {
  private readonly seen = new Map<string, { at: number; desktopAt?: number }>()
  /** How many times this process paused, stopped or removed each computer. */
  private readonly ended = new Map<string, number>()
  /** Handles given out on what was seen instead of asking the provider, until their first call. */
  private readonly guesses = new WeakMap<SandboxHandle, Guess>()

  /** Whether `box` was seen running within SEEN_MS. */
  running(box: SandboxHandle) {
    const entry = this.seen.get(keyOf(box))
    return entry !== undefined && Date.now() - entry.at < SEEN_MS
  }

  /** Whether the desktop on `box` was found current within SEEN_MS, on a computer still taken to be running. */
  desktopCurrent(box: SandboxHandle) {
    const at = this.seen.get(keyOf(box))?.desktopAt
    return at !== undefined && Date.now() - at < SEEN_MS && this.running(box)
  }

  /** Notes what starting the desktop on `box` found. */
  desktop(box: SandboxHandle, current: boolean) {
    const entry = this.seen.get(keyOf(box))
    if (!entry) return
    if (current) entry.desktopAt = Date.now()
    else delete entry.desktopAt
  }

  /** Records what the provider just said of a computer. */
  observe<T extends SandboxHandle | null>(box: T): T {
    if (box?.state === "running") this.seen.set(keyOf(box), { ...this.seen.get(keyOf(box)), at: box.observedAt })
    else if (box) this.forget(box)
    return box
  }

  /** A command came back from `box`, so it is still running. Never brings back what a failure or a pause forgot. */
  ran(box: SandboxHandle) {
    const entry = this.seen.get(keyOf(box))
    if (entry) entry.at = Date.now()
  }

  forget(box: SandboxHandle) {
    this.seen.delete(keyOf(box))
  }

  /** This process is pausing, stopping or removing `box`: a call that cuts short is not one to run again. */
  end(box: SandboxHandle) {
    this.forget(box)
    this.ended.set(keyOf(box), (this.ended.get(keyOf(box)) ?? 0) + 1)
  }

  /** `box` for a caller who gets it on what was seen: a copy, so that its first call can be told from later ones. */
  guess(box: SandboxHandle, sessionId: string): SandboxHandle {
    const copy = { ...box }
    this.guesses.set(copy, { sessionId, ended: this.ended.get(keyOf(box)) ?? 0 })
    return copy
  }

  /** Takes the guess off a handle. Whoever takes it deals with it having been wrong. */
  take(box: SandboxHandle) {
    const guess = this.guesses.get(box)
    this.guesses.delete(box)
    return guess
  }

  /** Whether this process has left `box` alone since `guess` was made. */
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
    // Forgotten again once it ends: a lookup during a slow pause may still have shown it running.
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
            // A desktop that failed an operation is asked how it is before the next one.
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
