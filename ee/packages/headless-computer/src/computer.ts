import { createHash, randomUUID } from "node:crypto"
import { posix } from "node:path"
import { ensureRunning, isSandboxError, shellQuote, SCOPE_LABEL, withBlocks, type RunSpec, type SandboxHandle, type SandboxProvider, type SandboxSpec, type SandboxState } from "@openwork/sandbox"
import { z } from "zod"
import type { ComputerFile, ComputerFiles, FileReader, ToolResult, ToolSpec } from "./types.js"
import { demonstrationReplySchema, type DemonstrationCommand } from "@openwork/types/browser-demonstration"
import { Desktop, DesktopError, type CarriedState, type DesktopState, type DesktopView } from "./desktop.js"
import { DESKTOP_TOOL } from "./desktop-tool.js"
import { DesktopTiming, timedProvider } from "./desktop-timing.js"
import { SeenRunning, watchedProvider } from "./seen-running.js"

/** One provider-neutral Linux computer per conversation. Jobs own idle policy and files; adapters own transport. */
export type ComputerOptions = {
  provider: SandboxProvider
  /** Existing Freestyle computers keep their hc-<hash> identity. */
  scope?: string
  idlePauseMs: number
  keepDays: number
  /** Keep each conversation's computer until it is removed instead of deleting it after keepDays unused. */
  persistent?: boolean
  desktop?: boolean
  /**
   * Where each conversation's pause time is kept so it outlives this process (the runner's store). The host runs
   * `pauseIdle` for the due ones; without it, only this process's timer pauses a computer.
   */
  pauses?: { set(sessionId: string, dueAt: number): void; clear(sessionId: string): void }
}
/** The desktop guest's viewer port (desktop-guest.mjs). */
const DESKTOP_VIEWER_PORT = 6080
/** What the model and the person are told while a computer waits to move to a new version. */
const UPDATING = "This computer is updating to a new version, which starts once its other commands and background jobs finish. Try again in a moment."
/**
 * How long a computer whose replacement came up on an older image stays put before another try. A gateway's template
 * keeps its name when it is rebuilt, so what a new computer comes up on is the only sign that it moved on. Each try costs
 * a pause and the running computer's memory, so an idle one waits a day; one that can't serve this runner has someone
 * waiting, and little to lose.
 */
const IDLE_REPLACEMENT_RETRY_MS = 24 * 60 * 60_000
const NEEDED_REPLACEMENT_RETRY_MS = 10 * 60_000
/** A computer replaced because its desktop wouldn't start isn't replaced again this soon: another fresh one won't do better. */
const RECOVERY_RETRY_MS = 10 * 60_000
/**
 * How often a paused computer is looked at again. Pauses are scheduled only when this runner uses a computer, so one
 * that anything else woke would run until its next use, and a provider's idle timeout doesn't see a desktop as idle
 * while its browser keeps connections open.
 */
export const PAUSED_RECHECK_MS = 60 * 60_000
/** How long a computer whose desktop won't start gets to hand its workspace and browser profile to its replacement. */
const RECOVERY_CARRY_MS = 20_000

const WORKSPACE = "/workspace"
const FILES_DIR = `${WORKSPACE}/files`
const OUT_DIR = `${WORKSPACE}/out`
/** Which /workspace/out files were already added to the person's Files (path → size:mtime), kept in the VM itself. */
const EXPORTED_MANIFEST = `${WORKSPACE}/.jobs/.exported.json`
const MANIFEST_MARKER = "---computer-exported---"
/** Which of the person's files were copied in (file id → its name in /workspace/files), kept in the VM next to it. */
const COPIED_MANIFEST = `${WORKSPACE}/.jobs/.copied.json`
const COPIED_MARKER = "---computer-copied---"
/**
 * Files move between the store and the computer directly when the store hands out links (ComputerFiles): the
 * computer fetches or sends them with curl in one command, so the bytes never pass through the runner. The time a
 * transfer gets grows with its size, at half a megabyte a second; its links stop working a minute after that.
 */
const TRANSFER_BASE_MS = 60_000
const TRANSFER_MS_PER_MB = 2_000
const MAX_TRANSFER_MS = 280_000
const TRANSFER_LINK_GRACE_SECONDS = 60
const TRANSFERS_AT_ONCE = 4
/** After a transfer in which nothing arrived, files go through the runner for this long before links are tried again. */
const DIRECT_RETRY_MS = 10 * 60_000
const TRANSFER_PLAN = ".openwork-transfer-"
const COPIED_LINE = "copied"
/** What a login shell would set, so `pip install --user` and npm globals are found without the slow profile. */
function computerBlocks(provider: SandboxProvider) { return withBlocks(provider, ["run", "files"], "Workbot computer") }
const GUEST_PATH = "/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
/** The longest a single command may run; Freestyle's exec limit. Longer work goes through `background`. */
const MAX_COMMAND_SECONDS = 300
/** A microVM pause writes a full checkpoint of disk and memory: about three minutes for a desktop on Fast Sandbox. */
export const PAUSE_TIMEOUT_MS = 5 * 60_000
/**
 * Resuming on a node that no longer holds the computer's checkpoint fetches it first: over two minutes on Fast Sandbox.
 * Stays inside the three minutes Workbot gives a desktop request.
 */
const START_TIMEOUT_MS = 170_000
const DEFAULT_COMMAND_SECONDS = 120
/** Each of stdout and stderr is cut to its last this-many characters: errors and results are at the end. */
const OUTPUT_TAIL_CHARS = 30_000
/** Files larger than this are not opened by `look` nor copied to the person's Files automatically. */
const MAX_LOOK_BYTES = 25 * 1024 * 1024
const MAX_EXPORT_BYTES = 200 * 1024 * 1024
/** Files that get a PDF preview rendered when they reach the person's Files. */
const PREVIEWABLE = /\.(pptx|ppt|docx|doc|odp|odt|key|pages|pdf)$/i
const MAX_PREVIEW_PAGES = 60
export const canPreview = (name: string) => PREVIEWABLE.test(name)
/** What renders those previews; part of the prepared image, installed on older computers when first needed. */
const OFFICE_PACKAGES = "fonts-liberation fonts-noto-core libreoffice-impress-nogui libreoffice-writer-nogui libreoffice-calc-nogui"

export class Computers {
  private readonly provider: SandboxProvider
  private readonly blocks: ReturnType<typeof computerBlocks>
  /** Sessions whose VM this process has resolved: the handle, so later calls skip the lookup. */
  private readonly vms = new Map<string, Promise<SandboxHandle>>()
  private readonly pauseTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly pausing = new Map<string, Promise<void>>()
  /** Sessions in a pause, or the idle guest update before it, that starting the computer calls off, so `vm()` doesn't wait for it. */
  private readonly checkpointing = new Set<string>()
  /** Saved file ids already copied into each session's VM by this process. */
  private readonly copied = new Map<string, Set<string>>()
  /** Until when files go through the runner because the last direct transfer brought nothing. */
  private directOffUntil = 0
  /** The desktop request being timed for each VM, by its slug. */
  private readonly timings = new Map<string, DesktopTiming>()
  /** How each session's desktop last started in this process; a `stale` one is replaced the next time it is idle. */
  private readonly desktops = new Map<string, DesktopState>()
  /** Commands and desktop operations in flight per session: a computer is replaced only when none but the caller's are. */
  private readonly working = new Map<string, number>()
  /** The replacement under way for each session, which concurrent callers (the view and the chat's glimpse) share. */
  private readonly replacing = new Map<string, Promise<SandboxHandle | null>>()
  /** Of each session's operations in flight (`working`), those still waiting for its desktop to start. */
  private readonly awaitingDesktop = new Map<string, number>()
  /** The decision under way on a computer whose desktop won't start, which everyone waiting on that start shares. */
  private readonly recovering = new Map<string, Promise<SandboxHandle | null>>()
  /** When each session's computer was last replaced for a desktop that wouldn't start. */
  private readonly recovered = new Map<string, number>()
  /** Computers seen running moments ago, which `vm()` and `startDesktop` don't ask about again. */
  private readonly seen = new SeenRunning()

  private readonly snapshot: string
  private readonly files?: ComputerFiles
  private readonly readFile: FileReader

  /** What the model is told about its computer, and the tools it gets; see COMPUTER_PROMPT and COMPUTER_TOOLS. */
  readonly prompt = COMPUTER_PROMPT
  readonly tools: ToolSpec[] = COMPUTER_TOOLS
  readonly toolNames: ReadonlySet<string> = COMPUTER_TOOL_NAMES
  readonly desktopTools: ToolSpec[]
  private readonly desktop?: Desktop

  /**
   * `files` is the conversation's kept files (uploads in, outputs out); without it the computer only runs commands.
   * `readFile` turns a file into what the model can see (images, PDFs, text), the same way tool results are read.
   */
  constructor(private readonly options: ComputerOptions, deps: { files?: ComputerFiles; readFile: FileReader }) {
    this.provider = watchedProvider(timedProvider(options.provider, key => this.timings.get(key)), this.seen, (sessionId, box, error) => this.afterWrongGuess(sessionId, box, error))
    this.blocks = computerBlocks(this.provider)
    this.snapshot = this.provider.currentImage()?.id ?? "configured image"
    this.files = deps.files
    this.readFile = deps.readFile
    this.desktop = options.desktop ? new Desktop(this.provider) : undefined
    this.desktopTools = this.desktop ? [DESKTOP_TOOL] : []
  }

  desktopRun(sessionId: string, input: Record<string, unknown>, signal?: AbortSignal, policy?: { browserRecovery: boolean }): Promise<ToolResult> {
    return this.holding(sessionId, () => this.runDesktop(sessionId, input, signal, policy))
  }

  private async runDesktop(sessionId: string, input: Record<string, unknown>, signal?: AbortSignal, policy?: { browserRecovery: boolean }): Promise<ToolResult> {
    // `description` and `show` are for the person (what it is doing, and whether to put it in front of them); they
    // never reach the computer.
    const parsed = z.object({ view: z.enum(["browser", "computer"]), operation: z.string().max(64), args: z.record(z.string(), z.unknown()), description: z.string().optional(), show: z.boolean().optional() }).strict().parse(input)
    const desktop = this.desktop
    if (!desktop) throw new Error("Desktop access is not configured.")
    signal?.throwIfAborted()
    const timing = this.track(sessionId, "tool")
    let box = await this.vm(sessionId).catch((error: unknown) => { this.finish(timing, "failed"); throw error })
    let stopping: Promise<unknown> | undefined
    const stop = () => {
      stopping ??= desktop.call(box, "/stop", {})
      void stopping.catch(() => {})
    }
    try {
      box = await this.startDesktop(sessionId, box, 1).catch((error: unknown) => { this.finish(timing, "failed"); throw error })
      // A tool call that found the desktop ready is not worth a log line; one that woke or started it is.
      this.finish(timing, "ok", !timing.prepared)
      signal?.addEventListener("abort", stop, { once: true })
      if (signal?.aborted) { stop(); signal.throwIfAborted() }
      const program = parsed.operation === "computer_run"
        ? z.object({ code: z.string().min(1).max(32_000), tabId: z.string().optional(), input: z.json().optional(), timeoutMs: z.number().int().min(1000).max(60_000).optional() }).strict().parse(parsed.args)
        : null
      const raw = await desktop.call(box, program ? "/computer/program" : parsed.view === "browser" ? "/browser/task" : "/computer/task", program
        ? { ...program, sessionId, browserRecovery: policy?.browserRecovery === true, surface: parsed.view }
        : { sessionId, browserRecovery: policy?.browserRecovery === true, ...(parsed.view === "browser" ? { operation: parsed.operation } : { name: parsed.operation }), args: parsed.args })
      signal?.throwIfAborted()
      const result = z.object({ ok: z.boolean().optional(), isError: z.boolean().optional(), image: z.object({ data: z.string(), mediaType: z.string().optional(), mimeType: z.string().optional() }).optional(), images: z.array(z.object({ data: z.string(), mimeType: z.string() })).optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional(), data: z.string().optional(), mimeType: z.string().optional() })).optional() }).loose().parse(raw)
      const images = result.content?.flatMap(part => part.type === "image" && part.data ? [{ mediaType: part.mimeType ?? "image/png", data: part.data }] : []) ?? []
      if (result.image) images.push({ mediaType: result.image.mediaType ?? result.image.mimeType ?? "image/png", data: result.image.data })
      for (const image of result.images ?? []) images.push({ mediaType: image.mimeType, data: image.data })
      const { image, images: programImages, content, ...text } = result
      return { output: content ? content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n") : JSON.stringify(text), isError: result.isError === true || result.ok === false, ...(images.length ? { images } : {}) }
    } finally {
      signal?.removeEventListener("abort", stop)
      try { if (stopping) await stopping }
      finally { this.release(sessionId) }
    }
  }

  async desktopViewer(sessionId: string, input: { view: DesktopView; control: boolean; origin: string }) {
    if (!this.desktop) throw new Error("Desktop access is not configured.")
    const timing = this.track(sessionId, "viewer")
    let outcome = "failed"
    try {
      // Seen running moments ago: it isn't paused, so nothing is asked. A view never wakes a computer, so when that
      // turns out wrong the computer is looked up after all.
      let failed: { error: unknown } | undefined
      if (await this.seenRunning(sessionId)) {
        try {
          const viewer = await this.view(this.desktop, sessionId, input)
          outcome = "ok"
          return viewer
        } catch (error) { failed = { error } }
      }
      const existing = await this.lookup(sessionId)
      if (existing?.state === "stopped" || existing?.state === "stopping") {
        outcome = "paused"
        return { state: "paused" as const }
      }
      // Still running: it failed for another reason.
      if (failed && existing?.state === "running") throw failed.error
      const viewer = await this.view(this.desktop, sessionId, input)
      outcome = "ok"
      return viewer
    } finally { this.finish(timing, outcome) }
  }

  /** A viewer ticket from the session's computer, which the caller knows or takes to be running. */
  private async view(desktop: Desktop, sessionId: string, input: { view: DesktopView; control: boolean; origin: string }) {
    const box = await this.vm(sessionId)
    // Not woken on a wrong guess: `desktopViewer` looks it up instead.
    this.seen.take(box)
    try { return { state: "connected" as const, ...await desktop.viewer(await this.startDesktop(sessionId, box), input) } }
    finally { this.release(sessionId) }
  }

  /** Whether the session's computer, as this process holds it, was seen running moments ago. */
  private async seenRunning(sessionId: string) {
    const pending = this.vms.get(sessionId)
    return pending !== undefined && this.seen.running(await pending)
  }

  /**
   * The session's computer as its provider has it now, without starting it. One found running is kept, so the `vm()`
   * that follows doesn't look it up again.
   */
  private async lookup(sessionId: string) {
    const pending = this.vms.get(sessionId)
    const existing = pending ? await this.provider.inspect(await pending) : await this.provider.find({ idempotencyKey: this.slug(sessionId), labels: this.spec(sessionId).labels })
    if (existing?.state === "running" && !this.vms.has(sessionId)) this.vms.set(sessionId, Promise.resolve(existing))
    return existing
  }

  browserDemonstration(sessionId: string, command: DemonstrationCommand) {
    return this.holding(sessionId, () => this.demonstrate(sessionId, command))
  }

  private async demonstrate(sessionId: string, command: DemonstrationCommand) {
    if (!this.desktop) throw new Error("Desktop access is not configured.")
    if (command.action === "read") {
      const existing = await this.lookup(sessionId)
      if (!existing || existing.state !== "running") throw new Error("Resume the computer before checking its demonstration.")
    }
    const box = await this.vm(sessionId)
    try {
      const ready = await this.startDesktop(sessionId, box, 1)
      return demonstrationReplySchema.parse(await this.desktop.call(ready, "/browser/demonstration", { sessionId, command }))
    } finally { this.release(sessionId) }
  }

  async desktopAction(sessionId: string, action: "continue" | "pause" | "resume" | "rebuild") {
    const timing = this.track(sessionId, action)
    let outcome = "failed"
    try {
      const result = await this.changeDesktop(sessionId, action)
      outcome = "ok"
      return result
    } finally { this.finish(timing, outcome) }
  }

  private async changeDesktop(sessionId: string, action: "continue" | "pause" | "resume" | "rebuild") {
    if (!this.desktop) throw new Error("Desktop access is not configured.")
    if (action === "rebuild") {
      // A fresh VM from the configured snapshot, without waking the old one first. Kept Files survive; the VM's own disk
      // does not: the person asked for a clean computer, so nothing is carried over.
      await this.delete(sessionId)
      try { this.desktops.set(sessionId, await this.desktop.start(await this.vm(sessionId))) }
      finally { this.release(sessionId) }
      return { ok: true }
    }
    const pending = this.vms.get(sessionId)
    const existing = action === "pause" ? pending ? await this.provider.inspect(await pending) : await this.provider.find({ idempotencyKey: this.slug(sessionId), labels: this.spec(sessionId).labels }) : null
    if (action === "pause" && (!existing || existing.state === "stopped" || existing.state === "stopping")) return { ok: true }
    const box = existing ?? await this.vm(sessionId)
    if (action === "pause") {
      if (!this.provider.blocks?.pause) throw new Error("This computer does not support pause.")
      await this.provider.blocks.pause(box, { timeoutMs: PAUSE_TIMEOUT_MS })
    } else if (action === "continue") {
      await this.desktop.call(box, "/continue", {})
    } else await this.startDesktop(sessionId, box)
    this.release(sessionId)
    return { ok: true }
  }

  /**
   * Runs one of the computer's tools (`bash` or `look`) for a conversation. `callKey` names this one call for good: a
   * command started under it can be picked up later (`pickUp`) if the wait for it is lost.
   */
  run(sessionId: string, name: string, input: Record<string, unknown>, callKey?: string): Promise<ToolResult> {
    return this.holding(sessionId, () => runComputerTool(this, sessionId, name, input, callKey))
  }

  /**
   * The result of a command started under `callKey` whose result never reached the runner: its real result once it
   * ends, or that it is still running. Null when this computer never started it. Never starts a command or a computer.
   */
  pickUp(sessionId: string, name: string, input: Record<string, unknown>, callKey: string): Promise<ToolResult | null> {
    return this.holding(sessionId, async () => {
      const parsed = name === "bash" ? bashInput.safeParse(input) : null
      if (!parsed?.success || !(await this.has(sessionId))) return null
      const job = commandJob(callKey)
      const limit = parsed.data.timeout_seconds ?? DEFAULT_COMMAND_SECONDS
      const outcome = await this.awaitCommand(sessionId, job, limit)
      if (outcome.status === "unknown" || outcome.status === "unconfirmed" || outcome.status === "direct") return null
      return this.commandResult(sessionId, job, limit, outcome, [])
    })
  }

  /** The snapshot new computers boot from, for logs. */
  get image() {
    return this.snapshot
  }

  /** The VM's slug: stable per session, opaque, and within Freestyle's 63-character limit. */
  slug(sessionId: string) {
    return `hc-${createHash("sha256").update(sessionId).digest("hex").slice(0, 40)}`
  }

  /** Whether this conversation has used its computer since the runner started. */
  known(sessionId: string) {
    return this.vms.has(sessionId)
  }

  /** Starts (or wakes) the conversation's VM and waits for it, for a host that chooses where a computer is made. */
  async start(sessionId: string) {
    await this.vm(sessionId)
    this.release(sessionId)
  }

  /** Whether the conversation has a computer here, running or paused, without starting it. */
  async has(sessionId: string) {
    return this.vms.has(sessionId) || Boolean(await this.provider.find({ idempotencyKey: this.slug(sessionId), labels: this.spec(sessionId).labels }))
  }

  /** Starts (or wakes) the conversation's VM in the background, so the first command doesn't wait for it. */
  prewarm(sessionId: string) {
    void this.vm(sessionId)
      .then((box) => this.execute(box, { command: "true", timeoutMs: 10_000 }))
      .catch(() => undefined)
      .finally(() => this.release(sessionId))
  }

  /** The conversation's VM, created from the snapshot on first use. A paused VM wakes on its next command. */
  async vm(sessionId: string): Promise<SandboxHandle> {
    this.cancelPause(sessionId)
    // In use: should this process stop before releasing it, it still pauses once the longest command would be done.
    this.options.pauses?.set(sessionId, Date.now() + this.options.idlePauseMs + MAX_COMMAND_SECONDS * 1000)
    // Calling a checkpoint off takes a moment and waiting it out takes minutes. What runs before it, like an idle
    // replacement, is still waited for.
    if (!this.checkpointing.delete(sessionId)) await this.pausing.get(sessionId)
    const prior = this.vms.get(sessionId)
    let guessed = false
    // Reserve the transition before awaiting provider state. Concurrent viewer
    // and tool requests must not both issue a start against the same paused VM.
    const pending = prior ? prior.then(async box => {
      // Seen running moments ago: not asked again. `afterWrongGuess` is what happens when it no longer is.
      if (this.seen.running(box)) {
        guessed = true
        return box
      }
      const current = await this.provider.inspect(box)
      if (current.state === "running") return current
      if (current.state === "missing") this.copied.delete(sessionId)
      return this.resolve(sessionId)
    }) : this.resolve(sessionId)
    this.vms.set(sessionId, pending)
    pending.catch(() => { if (this.vms.get(sessionId) === pending) this.vms.delete(sessionId) })
    const box = await pending
    return guessed ? this.seen.guess(box, sessionId) : box
  }

  /**
   * A call failed on a computer `vm()` took to be running without asking. Returns the computer to run it on once more
   * when that one turns out to have been paused or removed, so the call never started; null leaves the failure as it
   * is. A call that timed out may have started, and a computer still running failed for another reason: neither is
   * run twice.
   */
  private async afterWrongGuess(sessionId: string, box: SandboxHandle, error: unknown): Promise<SandboxHandle | null> {
    if (isSandboxError(error) && error.code === "timeout") return null
    const current = await this.provider.inspect(box).catch(() => null)
    if (!current || current.state === "running") return null
    return this.vm(sessionId)
  }

  private spec(sessionId: string): SandboxSpec {
    return {
      idempotencyKey: this.slug(sessionId), image: this.provider.currentImage(),
      labels: { kind: "headless-computer", ...(this.options.scope ? { [SCOPE_LABEL]: this.options.scope } : {}) },
      env: {}, storage: [], exposePorts: this.desktop ? [DESKTOP_VIEWER_PORT] : [],
      // Give the local background-job probe a minute of grace before provider
      // auto-pause. The backstop still bounds cost if the runner disappears.
      lifecycle: {
        ...(this.provider.id === "daytona" && this.provider.blocks?.pause
          ? { autoPauseMinutes: Math.max(1, Math.ceil(this.options.idlePauseMs / 60_000)) + 1, autoStopMinutes: 0 }
          : { autoStopMinutes: 60 }),
        autoDeleteMinutes: this.options.persistent ? -1 : this.options.keepDays * 1440,
      },
    }
  }

  private resolve(sessionId: string): Promise<SandboxHandle> {
    return ensureRunning(this.provider, this.spec(sessionId), { timeoutMs: START_TIMEOUT_MS })
  }

  private execute(box: SandboxHandle, spec: RunSpec) {
    return this.blocks.run(box, spec)
  }

  /** Recover before launching work; never retry an unknown command outcome. `reached`: the computer is up, and is being asked. */
  private async exec(sessionId: string, command: string, timeoutSeconds: number, reached?: () => void) {
    const box = await this.vm(sessionId)
    reached?.()
    if (this.desktop) return this.execute(box, {
      command: `printf %s ${shellQuote(JSON.stringify({ command }))} | sudo -n /usr/local/sbin/openwork-desktop-bridge command`,
      timeoutMs: timeoutSeconds * 1000,
    })
    return this.execute(box, {
      command: `cd ${WORKSPACE} 2>/dev/null || cd ~; exec bash -c "$WORKBOT_COMMAND"`,
      env: { WORKBOT_COMMAND: command, PATH: GUEST_PATH, HOME: "/home/ubuntu", LANG: "C.UTF-8" },
      timeoutMs: timeoutSeconds * 1000,
    })
  }

  /** Pauses the VM once the conversation has been quiet for a while, unless a background job is still running. */
  release(sessionId: string) {
    if (!this.vms.has(sessionId)) return
    this.cancelPause(sessionId)
    const timer = setTimeout(() => void this.pauseIfIdle(sessionId), this.options.idlePauseMs)
    timer.unref?.()
    this.pauseTimers.set(sessionId, timer)
    this.options.pauses?.set(sessionId, Date.now() + this.options.idlePauseMs)
  }

  /**
   * Pauses the conversation's computer if it is running and idle, for a host acting on a stored pause time
   * (`pauses`), including after a restart, when this process never used it. It never wakes a paused computer, and
   * keeps one due for another look (PAUSED_RECHECK_MS).
   */
  async pauseIdle(sessionId: string) {
    this.cancelPause(sessionId)
    const known = this.vms.get(sessionId)
    const box = await (known ? known.then(box => this.provider.inspect(box)) : this.provider.find({ idempotencyKey: this.slug(sessionId), labels: this.spec(sessionId).labels })).catch(() => undefined)
    // Unknown: look again after another idle period rather than at once.
    if (box === undefined) return this.options.pauses?.set(sessionId, Date.now() + this.options.idlePauseMs)
    if (box?.state !== "running") return this.resting(sessionId, box?.state)
    if (!known) this.vms.set(sessionId, Promise.resolve(box))
    await this.pauseIfIdle(sessionId, true)
  }

  /** What stays due for a computer that isn't running: another look while it is paused, nothing once it is gone. */
  private resting(sessionId: string, state: SandboxState | undefined) {
    if (state === undefined || state === "missing" || state === "archived") return this.options.pauses?.clear(sessionId)
    // Coming up: someone is starting it, so it is due as any running computer is.
    const soon = state === "creating" || state === "starting"
    this.options.pauses?.set(sessionId, Date.now() + (soon ? this.options.idlePauseMs : PAUSED_RECHECK_MS))
  }

  /** `running`: the caller has just seen the computer running. */
  private pauseIfIdle(sessionId: string, running = false): Promise<void> {
    const current = this.pausing.get(sessionId)
    if (current) return current
    const pending = this.checkIdle(sessionId, running).finally(() => this.pausing.delete(sessionId))
    this.pausing.set(sessionId, pending)
    return pending
  }

  private async checkIdle(sessionId: string, running: boolean) {
    this.pauseTimers.delete(sessionId)
    const pending = this.vms.get(sessionId)
    if (!pending) return this.options.pauses?.clear(sessionId)
    const started = Date.now()
    // One line per check: a computer that keeps running says here why. Two `paused` in a row with no use between them
    // mean something other than this runner woke it.
    const log = (outcome: string, error?: unknown) => console.log(`[headless-computer] idle pause ${JSON.stringify({ sessionId, outcome, ms: Date.now() - started, ...(error === undefined ? {} : { error: (error instanceof Error ? error.message : String(error)).slice(0, 300) }) })}`)
    try {
      let vm = await pending
      if (!running) {
        // The person or the provider may have paused it since: the checks below run commands, which would wake it.
        const state = (await this.provider.inspect(vm)).state
        if (state !== "running") {
          log(state)
          return this.resting(sessionId, state)
        }
      }
      // A command already running would carry on past the checkpoint, and its work would be lost.
      if (this.working.has(sessionId) || await this.runningJobs(vm) > 0) {
        log("in_use")
        return this.release(sessionId)
      }
      // Nobody is using it: the moment to move a computer built from an older image onto the current one, or to bring
      // an older guest up to this runner's, so the paused computer already carries it.
      const behind = this.working.has(sessionId) ? null : await this.behind(sessionId, vm)
      if (behind === "image") vm = await this.replace(sessionId, vm, { required: false }) ?? vm
      if (behind === "guest" && this.desktop) {
        // Someone coming back doesn't wait for this: `vm()` calls it off as it does a checkpoint, and a start of theirs
        // shares the update under way.
        this.checkpointing.add(sessionId)
        const began = Date.now()
        // Not fatal: the computer pauses with the guest it has, and its next use updates it as before.
        const outcome = await this.desktop.update(vm).then(changed => changed ? "updated" : "unchanged", (error: unknown) => `failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`)
        console.log(`[headless-computer] idle guest update ${JSON.stringify({ sessionId, outcome, ms: Date.now() - began })}`)
        if (!this.checkpointing.delete(sessionId)) return log("called_off")
      }
      // A provider that can neither pause nor stop keeps the computer running until its own expiry.
      if (!this.provider.describe().stopResume) {
        log("cannot_pause")
        return this.options.pauses?.clear(sessionId)
      }
      const callsOff = this.provider.describe().callsOffPause === true
      if (callsOff) this.checkpointing.add(sessionId)
      await (this.provider.blocks?.pause ? this.provider.blocks.pause(vm, { timeoutMs: PAUSE_TIMEOUT_MS }) : this.provider.stop(vm, { timeoutMs: PAUSE_TIMEOUT_MS }))
      // Called off: the computer is in use again, and `vm()` set when it is next due.
      if (callsOff && !this.checkpointing.delete(sessionId)) return log("called_off")
      log("paused")
      this.options.pauses?.set(sessionId, Date.now() + PAUSED_RECHECK_MS)
    } catch (error) {
      this.checkpointing.delete(sessionId)
      log("failed", error)
      // Not fatal: tried again after another idle period.
      this.options.pauses?.set(sessionId, Date.now() + this.options.idlePauseMs)
    }
  }

  /** Counts `work` as in flight for the session while it runs. */
  private async holding<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    this.working.set(sessionId, (this.working.get(sessionId) ?? 0) + 1)
    try { return await work() }
    finally {
      const left = (this.working.get(sessionId) ?? 1) - 1
      if (left > 0) this.working.set(sessionId, left)
      else this.working.delete(sessionId)
    }
  }

  /**
   * How many jobs are running: `background` jobs and commands (see `awaitCommand`), which both keep a `.running` file.
   * A command's file names its process, so one left behind by a command that was killed isn't counted for ever.
   */
  private async runningJobs(box: SandboxHandle, timeoutMs = 10_000) {
    const jobs = await this.execute(box, { command: RUNNING_JOBS, activity: "maintenance", timeoutMs })
    return Number(jobs.stdout?.trim() ?? "0")
  }

  /**
   * Starts the session's desktop on `box` and returns the computer it runs on. One whose image can't serve this runner
   * is replaced at once when nothing else is running on it (`self`: the caller's own operations in flight), carrying
   * its browser profile and workspace over; otherwise the caller hears that it is updating. One whose desktop won't
   * start is replaced the same way (`recover`), so the person isn't left to rebuild it themselves.
   */
  private async startDesktop(sessionId: string, box: SandboxHandle, self = 0): Promise<SandboxHandle> {
    const desktop = this.desktop
    if (!desktop) throw new Error("Desktop access is not configured.")
    // Found current on this computer moments ago: it isn't asked for its health again.
    if (this.seen.desktopCurrent(box)) return box
    this.awaitingDesktop.set(sessionId, (this.awaitingDesktop.get(sessionId) ?? 0) + self)
    try {
      await this.begin(desktop, sessionId, box)
      return box
    } catch (error) {
      if (!(error instanceof DesktopError)) throw error
      if (error.desktopCode === "desktop_unresponsive") {
        // A paused computer isn't unresponsive: it was paused since it was last seen, and replacing it would delete it.
        const state = (await this.provider.inspect(box).catch(() => null))?.state
        if (state === "stopped" || state === "stopping") throw error
        const fresh = await this.recover(sessionId, box)
        if (!fresh) throw error
        await this.begin(desktop, sessionId, fresh)
        return fresh
      }
      if (error.desktopCode !== "desktop_outdated") throw error
      if ((this.working.get(sessionId) ?? 0) > self || await this.runningJobs(box).catch(() => 1) > 0) throw new DesktopError("desktop_updating", UPDATING)
      if (await desktop.replacedInVain(box, NEEDED_REPLACEMENT_RETRY_MS)) throw error
      const fresh = await this.replace(sessionId, box, { required: true })
      if (!fresh) throw error
      await this.begin(desktop, sessionId, fresh)
      return fresh
    } finally {
      const left = (this.awaitingDesktop.get(sessionId) ?? self) - self
      if (left > 0) this.awaitingDesktop.set(sessionId, left)
      else this.awaitingDesktop.delete(sessionId)
    }
  }

  /** Starts the desktop on `box` and keeps what it found, for the idle check and for the next `startDesktop`. */
  private async begin(desktop: Desktop, sessionId: string, box: SandboxHandle) {
    const state = await desktop.start(box)
    this.desktops.set(sessionId, state)
    this.seen.desktop(box, state === "current")
  }

  /**
   * The replacement for a computer whose desktop won't start, or null when the computer stays: something other than
   * that start is running on it, or it is itself a replacement made moments ago.
   */
  private recover(sessionId: string, box: SandboxHandle): Promise<SandboxHandle | null> {
    let pending = this.recovering.get(sessionId)
    if (!pending) {
      pending = this.replaceUnresponsive(sessionId, box).finally(() => this.recovering.delete(sessionId))
      this.recovering.set(sessionId, pending)
    }
    return pending
  }

  private async replaceUnresponsive(sessionId: string, box: SandboxHandle) {
    if ((this.working.get(sessionId) ?? 0) > (this.awaitingDesktop.get(sessionId) ?? 0)) return null
    // Remembered by this process only: requests close enough together to replace it over and over keep the process alive.
    if (Date.now() - (this.recovered.get(sessionId) ?? 0) < RECOVERY_RETRY_MS) return null
    // One that still answers may be running a background job; one that doesn't has nothing it can hand over.
    const jobs = await this.runningJobs(box, 5_000).catch(() => null)
    if (jobs) return null
    this.recovered.set(sessionId, Date.now())
    console.log("[headless-computer] replacing a computer whose desktop didn't start", { sessionId, answers: jobs !== null })
    return this.replace(sessionId, box, { required: true, carryWithinMs: jobs === null ? 0 : RECOVERY_CARRY_MS })
  }

  /**
   * What on the session's computer is older than this runner's (known from its last start here, else asked): its
   * `image`, when moving it could help (a replacement that just came up on an older image shows new computers aren't
   * there yet), or only its `guest`, which is installed into the computer where it is.
   */
  private async behind(sessionId: string, box: SandboxHandle): Promise<"image" | "guest" | null> {
    if (!this.desktop) return null
    const known = this.desktops.get(sessionId)
    if (known === "current") return null
    if (!known) {
      // A helper from before in-place updates can't carry anything over, so such a computer is only replaced once its
      // desktop is needed, never while idle.
      const versions = await this.desktop.versions(box).catch(() => null)
      if (versions === null) return null
      if (versions.image === this.desktop.image) return versions.guest === this.desktop.guest ? null : "guest"
    }
    return await this.desktop.replacedInVain(box, IDLE_REPLACEMENT_RETRY_MS) ? null : "image"
  }

  /**
   * Moves the session onto a new computer from the current snapshot, carrying the browser profile and workspace over
   * as far as the old computer can export them; the person's Files are copied in again on next use. When the move is
   * optional (`required: false`), it only happens with everything carried, and otherwise returns null. `carryWithinMs`
   * limits how long the old computer gets to export them.
   */
  private replace(sessionId: string, box: SandboxHandle, options: { required: boolean; carryWithinMs?: number }): Promise<SandboxHandle | null> {
    let pending = this.replacing.get(sessionId)
    if (!pending) {
      pending = this.move(sessionId, box, options).finally(() => this.replacing.delete(sessionId))
      this.replacing.set(sessionId, pending)
    }
    return pending
  }

  private async move(sessionId: string, box: SandboxHandle, options: { required: boolean; carryWithinMs?: number }): Promise<SandboxHandle | null> {
    const started = Date.now()
    const carried: Array<[CarriedState, Uint8Array]> = []
    for (const name of ["workspace", "profile"] as const) {
      const left = options.carryWithinMs === undefined ? undefined : started + options.carryWithinMs - Date.now()
      const bytes = left !== undefined && left <= 0 ? null : await this.desktop?.exportState(box, name, left).catch(() => null)
      if (bytes) carried.push([name, bytes])
      else if (!options.required) return null
    }
    await this.delete(sessionId)
    // Not this.vm(): an idle replacement runs while the session's pause is in progress, which vm() waits for.
    const pending = this.resolve(sessionId)
    this.vms.set(sessionId, pending)
    pending.catch(() => { if (this.vms.get(sessionId) === pending) this.vms.delete(sessionId) })
    const fresh = await pending
    const kept: CarriedState[] = []
    for (const [name, bytes] of carried) {
      try {
        await this.desktop?.importState(fresh, name, bytes)
        kept.push(name)
      } catch (error) {
        console.error("[headless-computer] carrying state over failed", { sessionId, name, error: error instanceof Error ? error.message : "unknown" })
      }
    }
    await this.desktop?.noteReplacement(fresh).catch(() => undefined)
    console.log("[headless-computer] computer replaced", { sessionId, required: options.required, carried: kept, ms: Date.now() - started, image: this.snapshot })
    return fresh
  }

  private cancelPause(sessionId: string) {
    const timer = this.pauseTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.pauseTimers.delete(sessionId)
  }

  /** Times one desktop request; the first one open for a VM gets its steps, a concurrent one only its total. */
  private track(sessionId: string, operation: string) {
    const timing = new DesktopTiming(sessionId, operation)
    const slug = this.slug(sessionId)
    if (!this.timings.has(slug)) this.timings.set(slug, timing)
    return timing
  }

  private finish(timing: DesktopTiming, outcome: string, quiet = false) {
    const slug = this.slug(timing.sessionId)
    if (this.timings.get(slug) === timing) this.timings.delete(slug)
    if (!quiet) timing.log(outcome)
  }

  /** Deletes the conversation's VM, if it has one. */
  async delete(sessionId: string) {
    this.cancelPause(sessionId)
    this.options.pauses?.clear(sessionId)
    this.vms.delete(sessionId)
    this.copied.delete(sessionId)
    this.desktops.delete(sessionId)
    const box = await this.provider.find({ idempotencyKey: this.slug(sessionId), labels: this.spec(sessionId).labels })
    if (box) await this.provider.destroy(box, { timeoutMs: 30_000 }).catch((error: unknown) => {
      if (!isSandboxError(error) || error.code !== "not_found") throw error
    })
  }

  /**
   * Copies files the person sent into /workspace/files. Returns the paths it copied this time. What is already there
   * is read in one command: the folder's names and sizes, and the record of earlier copies kept on the computer, so
   * a new process doesn't ask about each file. Missing files are fetched by the computer itself where the store
   * hands out links, all in one command; otherwise, or when that doesn't arrive, they go through the runner.
   */
  private async copyUploads(sessionId: string): Promise<string[]> {
    if (!this.files) return []
    const done = this.copied.get(sessionId) ?? new Set<string>()
    this.copied.set(sessionId, done)
    const pending = this.files.list(sessionId).filter((file) => file.source === "user" && !done.has(file.id))
    if (pending.length === 0) return []
    const vm = await this.vm(sessionId)
    const seen = await this.execute(vm, {
      command: `find ${FILES_DIR} -mindepth 1 -maxdepth 1 -printf '%f\\t%s\\n' 2>/dev/null; echo '${COPIED_MARKER}'; cat ${COPIED_MANIFEST} 2>/dev/null || echo '{}'`,
      timeoutMs: 30_000,
    })
    const [listed = "", recordText = "{}"] = (seen.stdout ?? "").split(`${COPIED_MARKER}\n`)
    const present = new Map(listed.split("\n").filter(Boolean).map((line) => {
      const tab = line.lastIndexOf("\t")
      return [line.slice(0, tab), Number(line.slice(tab + 1))] as const
    }))
    // File id → the name it was copied under. It only counts while that file is still there at that size: a
    // replacement computer carries this record over but not /workspace/files.
    const record = z.record(z.string(), z.string()).catch({}).parse(safeJson(recordText.trim()))
    const missing: Array<{ file: ComputerFile; path: string }> = []
    let recorded = false
    for (const file of pending) {
      const earlier = record[file.id]
      if (earlier !== undefined && present.get(earlier) === file.size) {
        done.add(file.id)
        continue
      }
      const place = uploadPath(present, file.name, file.size)
      record[file.id] = place.name
      recorded = true
      if (place.exists) {
        done.add(file.id)
        continue
      }
      // Taken from here on, so another file of this name sent with it gets its own.
      present.set(place.name, file.size)
      missing.push({ file, path: `${FILES_DIR}/${place.name}` })
    }
    const recordJson = JSON.stringify(record)
    const fetched = await this.fetchUploads(sessionId, vm, missing, recordJson)
    const copied: string[] = []
    for (const { file, path } of missing) {
      if (!fetched.has(file.id)) {
        const found = await this.files.read(sessionId, file.id)
        if (!found) {
          done.add(file.id)
          continue
        }
        await this.blocks.files.write(vm, path, found.bytes, { timeoutMs: 30_000, ...(this.desktop ? { mode: 0o660 } : {}) })
      }
      done.add(file.id)
      copied.push(path)
    }
    // The fetching command writes the record itself; otherwise it is written here, when it changed. Without it the
    // next process still finds the files by name and size.
    if (recorded && fetched.size === 0) await this.blocks.files.write(vm, COPIED_MANIFEST, new TextEncoder().encode(recordJson), { timeoutMs: 30_000 }).catch(() => undefined)
    return copied
  }

  /**
   * Has the computer fetch the person's files from the store itself, all in one command. Each is fetched under a
   * temporary name, checked against its size, given the permissions a copy through the runner gets, and only then
   * moved into place. Returns the ids of the files that arrived; the rest are left for the runner to carry.
   */
  private async fetchUploads(sessionId: string, vm: SandboxHandle, missing: Array<{ file: ComputerFile; path: string }>, recordJson: string): Promise<Set<string>> {
    const arrived = new Set<string>()
    const files = this.files
    if (!files?.downloadUrl || missing.length === 0 || Date.now() < this.directOffUntil) return arrived
    const timeoutMs = transferTimeoutMs(missing.reduce((total, { file }) => total + file.size, 0))
    const token = randomUUID().replaceAll("-", "")
    let outcome: unknown
    try {
      const fetching: Array<{ file: ComputerFile; path: string; part: string; url: string }> = []
      for (const [index, entry] of missing.entries()) {
        const url = await files.downloadUrl(sessionId, entry.file.id, linkSeconds(timeoutMs))
        if (url) fetching.push({ ...entry, url, part: `${FILES_DIR}/.openwork-part-${token}-${index}` })
      }
      if (fetching.length === 0) return arrived
      const result = await this.transfer(vm, {
        token,
        blocks: fetching.map(({ url, part }) => [`url = "${url}"`, `output = "${part}"`]),
        timeoutMs,
        cleanup: fetching.map(({ part }) => part),
        after: [
          ...fetching.map(({ file, path, part }, index) =>
            `[ "$(stat -c %s ${part} 2>/dev/null)" = ${file.size} ] && ${this.desktop ? `chmod 660 ${part} && ` : ""}mv -fT -- ${part} ${shellQuote(path)} && echo ${COPIED_LINE} ${index}`),
          `printf %s ${shellQuote(recordJson)} > ${COPIED_MANIFEST}`,
        ],
      })
      for (const line of result.stdout.split("\n")) {
        const [word, index] = line.trim().split(" ")
        const entry = word === COPIED_LINE ? fetching[Number(index)] : undefined
        if (entry) arrived.add(entry.file.id)
      }
      outcome = result.stderr
    } catch (error) {
      outcome = error
    }
    if (arrived.size === 0) this.directFailed(sessionId, "to the computer", missing.length, outcome)
    return arrived
  }

  /**
   * Runs curl on the computer over `blocks`, one transfer each, then the `after` commands. The links are written to a
   * file, never to a command line, and the file is removed when the command ends. On a desktop, commands run as a
   * separate account that can't enter the folder it is in; elsewhere there is one account.
   */
  private async transfer(vm: SandboxHandle, input: { token: string; blocks: string[][]; before?: string[]; after?: string[]; cleanup?: string[]; timeoutMs: number }) {
    const folder = this.transferFolder
    const plan = `${folder}/${TRANSFER_PLAN}${input.token}`
    const seconds = Math.max(10, Math.floor(input.timeoutMs / 1000) - 10)
    const config = input.blocks.map((block) => [...block, "fail", "globoff", "connect-timeout = 10", `max-time = ${seconds}`].join("\n")).join("\nnext\n")
    await this.blocks.files.write(vm, plan, new TextEncoder().encode(`${config}\n`), { timeoutMs: 10_000 })
    return this.execute(vm, {
      command: [
        `trap 'rm -rf ${[plan, `${plan}.d`, ...(input.cleanup ?? [])].join(" ")}' EXIT`,
        `chmod 600 ${plan}`,
        // Whatever an interrupted transfer left behind; its links have long stopped working.
        `find ${folder} -maxdepth 1 -name '${TRANSFER_PLAN}*' -mmin +15 -exec rm -rf {} + 2>/dev/null`,
        ...(input.before ?? []),
        `curl --silent --show-error --parallel --parallel-max ${TRANSFERS_AT_ONCE} --config ${plan} >/dev/null`,
        ...(input.after ?? []),
        "true",
      ].join("\n"),
      timeoutMs: input.timeoutMs,
    })
  }

  /** Where a transfer's links are written: the provider account's own folder on a desktop, the jobs folder elsewhere. */
  private get transferFolder() {
    return this.desktop ? "/home/ubuntu" : `${WORKSPACE}/.jobs`
  }

  /** Files go through the runner for a while after a direct transfer in which nothing arrived. */
  private directFailed(sessionId: string, direction: string, files: number, outcome: unknown) {
    this.directOffUntil = Date.now() + DIRECT_RETRY_MS
    const detail = (outcome instanceof Error ? outcome.message : typeof outcome === "string" ? outcome : "").replace(/https?:\/\/\S+/g, "[link]").trim().slice(-300)
    console.warn("[headless-computer] a direct file transfer brought nothing; files go through the runner for now", { sessionId, direction, files, ...(detail ? { detail } : {}) })
  }

  /**
   * Adds new or changed files in /workspace/out to the person's files. Returns what was added, and what wasn't. The
   * computer sends them to the store itself where the store hands out links, all in one command; what doesn't
   * arrive that way goes through the runner.
   */
  private async exportOutputs(sessionId: string): Promise<{ saved: string[]; skipped: string[] }> {
    if (!this.files) return { saved: [], skipped: [] }
    const files = this.files
    const maxBytes = Math.min(MAX_EXPORT_BYTES, files.maxFileBytes)
    const vm = await this.vm(sessionId)
    const listing = await this.execute(vm, {
      command: `find ${OUT_DIR} -type f -not -name '.*' -printf '%P\\t%s\\t%T@\\n' 2>/dev/null; echo '${MANIFEST_MARKER}'; cat ${EXPORTED_MANIFEST} 2>/dev/null || echo '{}'`,
      timeoutMs: 30_000,
    })
    const [listed = "", manifestText = "{}"] = (listing.stdout ?? "").split(`${MANIFEST_MARKER}\n`)
    // path → "size:mtime|fileId": the version last added, and the saved file it became.
    const manifest = z.record(z.string(), z.string()).catch({}).parse(safeJson(manifestText.trim()))
    const saved: string[] = []
    const skipped: string[] = []
    let changed = false
    // A version that doesn't fit is recorded as seen, so it is reported once rather than after every command.
    const notKept = (output: Output, reason: string) => {
      skipped.push(`${output.relative} (${reason})`)
      manifest[output.relative] = `${output.signature}|${output.previousId ?? ""}`
      changed = true
    }
    const outputs: Output[] = []
    for (const line of listed.split("\n").filter(Boolean)) {
      const [relative, sizeText, mtime] = line.split("\t")
      if (!relative || !sizeText) continue
      const size = Number(sizeText)
      const signature = `${size}:${mtime}`
      const [previousSignature, recordedId] = (manifest[relative] ?? "").split("|")
      if (previousSignature === signature) continue
      // Outputs recorded before ids were kept: the newest file it made under that name is the earlier version.
      const previousId = recordedId || (previousSignature ? files.list(sessionId).find((file) => file.source === "agent" && file.name === posix.basename(relative))?.id : undefined)
      const output = { relative, size, signature, previousId }
      if (size > maxBytes) notKept(output, `${formatBytes(size)}; the most a kept file can be is ${formatBytes(maxBytes)}`)
      else outputs.push(output)
    }
    const sent = await this.sendOutputs(sessionId, vm, outputs)
    for (const output of outputs) {
      const { relative, previousId } = output
      const direct = sent.get(relative)
      if (direct instanceof Error) {
        notKept(output, direct.message)
        continue
      }
      // A new version of a file already handed over updates it in place: one file in their Files, and anything
      // showing it (the answer's card, an open preview) moves to the new version.
      let file = direct ?? null
      if (!file) {
        const bytes = new Uint8Array(await this.blocks.files.read(vm, `${OUT_DIR}/${relative}`, { timeoutMs: 30_000 }))
        try {
          file =
            (previousId ? await files.replace(sessionId, previousId, { bytes }) : null) ??
            (await files.add(sessionId, { name: posix.basename(relative), bytes, source: "agent" }))
        } catch (error) {
          // Over the conversation's limits: final for this version. Anything else (storage briefly unreachable)
          // is left unrecorded, so the next command tries again.
          if (isLimitError(error)) {
            notKept(output, error.message)
            continue
          }
          throw error
        }
      }
      manifest[relative] = `${output.signature}|${file.id}`
      changed = true
      saved.push(file.name)
      // Slides, documents and PDFs get page images for the preview panel, made in the background.
      if (canPreview(relative)) void this.renderPreview(sessionId, file.id, `${OUT_DIR}/${relative}`).catch(() => undefined)
    }
    if (changed) await this.blocks.files.write(vm, EXPORTED_MANIFEST, new TextEncoder().encode(JSON.stringify(manifest)), { timeoutMs: 30_000 })
    return { saved, skipped }
  }

  /**
   * Has the computer send changed outputs to the store itself, all in one command. The store measures what arrived
   * before keeping it, so the limits hold whatever was sent. Returns, by path, the kept file or the limit it ran
   * into; an output that isn't in the result didn't arrive and is left for the runner to carry.
   */
  private async sendOutputs(sessionId: string, vm: SandboxHandle, outputs: Output[]): Promise<Map<string, ComputerFile | Error>> {
    const settled = new Map<string, ComputerFile | Error>()
    const files = this.files
    if (!files?.receive || outputs.length === 0 || Date.now() < this.directOffUntil) return settled
    const timeoutMs = transferTimeoutMs(outputs.reduce((total, output) => total + output.size, 0))
    const sending: Array<{ output: Output; url: string; finish(): Promise<ComputerFile | null> }> = []
    for (const output of outputs) {
      try {
        const place = await files.receive(sessionId, { name: posix.basename(output.relative), size: output.size, source: "agent", replaces: output.previousId, expiresSeconds: linkSeconds(timeoutMs) })
        if (place) sending.push({ output, ...place })
      } catch (error) {
        // Anything but a limit is the store's trouble: the runner's own way reports it.
        if (isLimitError(error)) settled.set(output.relative, error)
      }
    }
    if (sending.length === 0) return settled
    const token = randomUUID().replaceAll("-", "")
    const links = `${this.transferFolder}/${TRANSFER_PLAN}${token}.d`
    // curl reads each output through a link with a plain name, so a file's own name never has to be quoted for it.
    const outcome: unknown = await this.transfer(vm, {
      token,
      blocks: sending.map(({ url }, index) => [`url = "${url}"`, `upload-file = "${links}/${index}"`]),
      timeoutMs,
      before: ["umask 077", `mkdir ${links} || exit 1`, ...sending.map(({ output }, index) => `ln -s -- ${shellQuote(`${OUT_DIR}/${output.relative}`)} ${links}/${index}`)],
    }).then((result) => result.stderr, (error: unknown) => error)
    let arrived = 0
    for (const { output, finish } of sending) {
      try {
        const file = await finish()
        if (!file) continue
        settled.set(output.relative, file)
        arrived += 1
      } catch (error) {
        if (!isLimitError(error)) continue
        settled.set(output.relative, error)
        arrived += 1
      }
    }
    if (arrived === 0) this.directFailed(sessionId, "from the computer", sending.length, outcome)
    return settled
  }

  /** Renders a kept file's preview on demand (files from before previews, or ones the person sent). */
  async previewSavedFile(sessionId: string, fileId: string) {
    if (!this.files) return
    const found = await this.files.read(sessionId, fileId)
    if (!found || !canPreview(found.file.name)) return
    const vm = await this.vm(sessionId)
    const extension = posix.extname(found.file.name).toLowerCase()
    const path = `/tmp/computer-preview/source/${fileId}${extension}`
    await this.execute(vm, { command: "mkdir -p /tmp/computer-preview/source", timeoutMs: 10_000 })
    await this.blocks.files.write(vm, path, found.bytes, { timeoutMs: 30_000 })
    await this.renderPreview(sessionId, fileId, path, false)
  }

  /**
   * Renders an Office file with LibreOffice on the computer and keeps its pages as images, the file's preview.
   * `floating`: nothing waits for it (a command's output), so nothing keeps the runner alive until it is done.
   */
  private async renderPreview(sessionId: string, fileId: string, path: string, floating = true) {
    if (!this.files) return
    // A line when it starts and one when it ends, ids and times only: a start without an end is a preview that was
    // lost with its runner, which is how often that happens.
    const started = Date.now()
    console.log(`[headless-computer] preview started ${JSON.stringify({ sessionId, fileId, floating })}`)
    const done = { outcome: "failed", pages: 0 }
    try { await this.renderPages(sessionId, fileId, path, done) }
    finally { console.log(`[headless-computer] preview finished ${JSON.stringify({ sessionId, fileId, floating, ...done, ms: Date.now() - started })}`) }
  }

  private async renderPages(sessionId: string, fileId: string, path: string, done: { outcome: string; pages: number }) {
    if (!this.files) return
    // The version being rendered: if the file is revised meanwhile, these pages are stale and are not kept.
    const version = this.files.list(sessionId).find((file) => file.id === fileId)?.updatedAt
    const vm = await this.vm(sessionId)
    // A computer made from an older image has no LibreOffice yet: install it once, quietly, instead of
    // replacing the computer and its files.
    const has = await this.execute(vm, { command: "command -v soffice >/dev/null && echo yes", timeoutMs: 10_000 })
    if (has.stdout?.trim() !== "yes" && !path.toLowerCase().endsWith(".pdf")) {
      await this.execute(vm, {
        command: `sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ${OFFICE_PACKAGES} >/dev/null 2>&1`,
        timeoutMs: 290_000,
      })
    }
    const outDir = `/tmp/computer-preview/${fileId}`
    // PDFs are paged as they are; Office files go through LibreOffice first.
    const rendered = path.toLowerCase().endsWith(".pdf")
      ? await this.execute(vm, { command: `mkdir -p "$OUT" && echo "$SRC"`, env: { OUT: outDir, SRC: path }, timeoutMs: 10_000 })
      : await this.execute(vm, {
          command: `mkdir -p "$OUT" && timeout 120 soffice --headless --norestore --convert-to pdf --outdir "$OUT" "$SRC" >/dev/null 2>&1; ls "$OUT"/*.pdf 2>/dev/null | head -1`,
          env: { OUT: outDir, SRC: path, HOME: "/tmp/computer-preview", PATH: GUEST_PATH },
          timeoutMs: 150_000,
        })
    const pdfPath = rendered.stdout?.trim()
    if (!pdfPath) {
      done.outcome = "not_rendered"
      return
    }
    // One image per page (at most 60), 1600px on the long side: the panel lays them out like a deck.
    const paged = await this.execute(vm, {
      command: `pdftoppm -png -l ${MAX_PREVIEW_PAGES} -scale-to 1600 "$PDF" "$OUT/page" && ls "$OUT"/page-*.png | sort -V`,
      env: { OUT: outDir, PDF: pdfPath, PATH: GUEST_PATH },
      timeoutMs: 120_000,
    })
    const pagePaths = (paged.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean)
    const pages: Array<Uint8Array<ArrayBuffer>> = []
    for (const pagePath of pagePaths) pages.push(new Uint8Array(await this.blocks.files.read(vm, pagePath, { timeoutMs: 30_000 })))
    const size = pngSize(pages[0])
    const current = this.files.list(sessionId).find((file) => file.id === fileId)?.updatedAt
    done.pages = pages.length
    done.outcome = !size ? "no_pages" : current !== version ? "revised" : "failed"
    if (size && current === version) done.outcome = (await this.files.putPreview(sessionId, fileId, pages, size)) ? "kept" : "not_kept"
    await this.execute(vm, { command: `rm -rf "$OUT"`, env: { OUT: outDir }, timeoutMs: 10_000 }).catch(() => undefined)
  }

  async bash(sessionId: string, command: string, timeoutSeconds: number, callKey?: string): Promise<ToolResult> {
    const copied = await this.copyUploads(sessionId)
    const job = commandJob(callKey)
    return this.commandResult(sessionId, job, timeoutSeconds, await this.awaitCommand(sessionId, job, timeoutSeconds, command), copied)
  }

  /**
   * Waits for a command to end, starting it first when `command` is given. The command runs on the computer apart
   * from the request that waits for it, keeps its output and exit code in files, and stops itself at its time limit.
   * So a wait that is cut (the provider's limit, a runner that stops) loses nothing: the next wait for the same `job`
   * finds it, and a command is never started twice. `unknown`: this computer has no such command.
   */
  private async awaitCommand(sessionId: string, job: string, limitSeconds: number, command?: string): Promise<CommandOutcome> {
    // The command is over by then: its limit, the time it gets to stop, and a moment to record how it ended.
    const longest = limitSeconds + STOP_GRACE_SECONDS + 5
    let left = longest
    let start = command === undefined ? undefined : { command, limitSeconds }
    let askedAt: number | undefined
    let cut = false
    for (;;) {
      const waitSeconds = Math.min(left, MAX_WAIT_SECONDS)
      left -= waitSeconds
      const result = await this.exec(sessionId, commandScript(job, waitSeconds, start), waitSeconds + WAIT_SLACK_SECONDS, () => { askedAt ??= Date.now() }).catch((error: unknown) => {
        if (!isSandboxError(error) || error.code !== "timeout") throw error
        return null
      })
      if (!result) {
        // The wait was cut, not the command: one more wait, for what is left of its time, which starts nothing. Not
        // when the computer never came up, nor a second time.
        if (cut || askedAt === undefined) return { status: "unconfirmed" }
        cut = true
        left = Math.max(1, longest - Math.floor((Date.now() - askedAt) / 1000))
        start = undefined
        continue
      }
      const outcome = readCommand(result)
      if (outcome.status !== "running" || left <= 0) return outcome
      start = undefined
    }
  }

  /** What the model is told about a command, and its outputs added to the person's Files once it has ended. */
  private async commandResult(sessionId: string, job: string, limitSeconds: number, outcome: CommandOutcome, copied: string[]): Promise<ToolResult> {
    const copiedNote = copied.length ? `[Copied the person's files to: ${copied.join(", ")}]` : ""
    const unfinished = (note: string, output: { stdout: string; stderr: string }) => ({
      output: [copiedNote, note, output.stdout, output.stderr ? `[stderr]\n${output.stderr}` : ""].filter(Boolean).join("\n"),
      isError: true,
    })
    if (outcome.status === "unconfirmed" || outcome.status === "unknown") {
      return unfinished(`[No confirmed result after ${limitSeconds}s. The command may still be running; do not repeat side effects. Use background for long jobs.]`, { stdout: "", stderr: "" })
    }
    if (outcome.status === "running") {
      return unfinished(`[Still running: it did not stop at its ${limitSeconds}s limit. Its output so far is in ${JOBS_DIR}/${job}.out and ${job}.err, and ${JOBS_DIR}/${job}.exit will hold its exit code once it ends. Check on it there; do not repeat side effects.]`, outcome)
    }
    if (outcome.status === "lost") {
      return unfinished("[The command's process ended without an exit code: it was killed, or the computer restarted under it. Check its effect before repeating it.]", outcome)
    }
    if (outcome.status === "done" && outcome.stopped) {
      return unfinished(`[Stopped after ${limitSeconds}s, its time limit, before it finished. Use background for long jobs.]`, outcome)
    }
    const { saved, skipped } = await this.exportOutputs(sessionId).catch(() => ({ saved: [], skipped: [] }))
    const parts = [
      copiedNote,
      `[exit ${outcome.exitCode}]`,
      outcome.stdout,
      outcome.stderr ? `[stderr]\n${outcome.stderr}` : "",
      saved.length ? `[Added to their Files: ${saved.join(", ")}]` : "",
      skipped.length ? `[Not added to their Files: ${skipped.join("; ")}. Make it smaller, or tell them it is too big to hand over.]` : "",
    ]
    return { output: parts.filter(Boolean).join("\n"), isError: outcome.exitCode !== 0 }
  }

  async look(sessionId: string, paths: string[]): Promise<ToolResult> {
    await this.copyUploads(sessionId)
    const vm = await this.vm(sessionId)
    const counts = { images: 0, documents: 0 }
    const texts: string[] = []
    const result: ToolResult = { output: "", isError: false, images: [], documents: [] }
    for (const raw of paths) {
      const path = posix.resolve(WORKSPACE, raw)
      const stat = await this.blocks.files.stat(vm, path, { timeoutMs: 10_000 })
      if (!stat || stat.kind !== "file") {
        texts.push(`[${path}: no such file]`)
        result.isError = paths.length === 1
        continue
      }
      if (stat.size > MAX_LOOK_BYTES) {
        texts.push(`[${path} is ${formatBytes(stat.size)}, too large to look at. Make a smaller version with bash first.]`)
        continue
      }
      const bytes = await this.blocks.files.read(vm, path, { timeoutMs: 30_000 })
      const name = posix.basename(path)
      const reading = await this.readFile({ name, bytes }, counts)
      const unreadable = !reading.image && !reading.document && reading.text.startsWith("[Can't open")
      texts.push(
        unreadable
          ? `[${path} (${formatBytes(stat.size)}) can't be shown directly. Convert it with bash first, for example frames from a video: ffmpeg -i "${path}" -vf fps=1/2,scale=1280:-2 ${WORKSPACE}/frames/%03d.png, then look at a few of them.]`
          : `${path}\n${reading.text}`,
      )
      if (reading.image) result.images?.push(reading.image)
      if (reading.document) result.documents?.push(reading.document)
    }
    result.output = texts.join("\n\n")
    if (!result.images?.length) delete result.images
    if (!result.documents?.length) delete result.documents
    return result
  }
}

/** A changed file in /workspace/out: its path there, the version seen (size:mtime), and the kept file it updates. */
type Output = { relative: string; size: number; signature: string; previousId: string | undefined }

/**
 * A person's file's name in /workspace/files: its own, or a variant when a different file already has that name.
 * `present` is what the folder holds (name → size); a file of the same name and size is taken to be this one.
 */
function uploadPath(present: ReadonlyMap<string, number>, name: string, size: number) {
  const plain = posix.basename(name)
  const base = plain && plain !== "." && plain !== ".." ? plain : "file"
  const extension = posix.extname(base)
  const stem = base.slice(0, base.length - extension.length)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? base : `${stem} (${attempt + 1})${extension}`
    const taken = present.get(candidate)
    if (taken === undefined) return { name: candidate, exists: false }
    if (taken === size) return { name: candidate, exists: true }
  }
  return { name: `${Date.now()}-${base}`, exists: false }
}

/** How long a direct transfer of this many bytes may take, and how long its links work. */
const transferTimeoutMs = (bytes: number) => Math.min(MAX_TRANSFER_MS, TRANSFER_BASE_MS + Math.ceil(bytes / (1024 * 1024)) * TRANSFER_MS_PER_MB)
const linkSeconds = (timeoutMs: number) => Math.ceil(timeoutMs / 1000) + TRANSFER_LINK_GRACE_SECONDS

/** Width and height from a PNG's header. */
function pngSize(bytes: Uint8Array | undefined) {
  if (!bytes || bytes.byteLength < 24) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** The file store's "doesn't fit" error (a per-file or per-conversation limit); its message is for the model. */
function isLimitError(error: unknown): error is Error {
  return error instanceof Error && "code" in error && (error.code === "file_too_large" || error.code === "files_full")
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${Number((bytes / (1024 * 1024 * 1024)).toFixed(1))} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} bytes`
}

/** `earlier`: how much of the output the computer had already dropped before this end of it. */
function tail(text: string, earlier = 0) {
  const trimmed = text.trimEnd()
  const cut = Math.max(0, trimmed.length - OUTPUT_TAIL_CHARS) + earlier
  return cut ? `…[${cut} earlier characters cut]\n${trimmed.slice(-OUTPUT_TAIL_CHARS)}` : trimmed
}

/** Where commands and `background` jobs keep their files: `<job>.running` while one runs. */
const JOBS_DIR = `${WORKSPACE}/.jobs`
/** How long a command gets to stop once its time is up, before it is killed. */
const STOP_GRACE_SECONDS = 5
/** How much longer than its wait a request for a command may take, and the longest wait that leaves within MAX_COMMAND_SECONDS. */
const WAIT_SLACK_SECONDS = 10
const MAX_WAIT_SECONDS = MAX_COMMAND_SECONDS - WAIT_SLACK_SECONDS
/** The end of each stream is kept and read back in bytes: all that its last OUTPUT_TAIL_CHARS characters can take. */
const OUTPUT_TAIL_BYTES = OUTPUT_TAIL_CHARS * 4
/** A command's files stay this long after it started, for a wait that comes back for its result. */
const COMMAND_KEPT_MINUTES = 24 * 60
/** Starts the first line of what `commandScript` prints. */
const COMMAND_MARKER = "---computer-command---"

type CommandOutput = { stdout: string; stderr: string }
/**
 * How a command stands. `done`: it ended (`stopped`: at its time limit). `direct`: it ran inside the request, with no
 * files to come back to. `lost`: it was started, and is neither running nor done. `unknown`: the computer has no such
 * command. `unconfirmed`: the computer couldn't be asked.
 */
type CommandOutcome =
  | ({ status: "done"; exitCode: number; stopped: boolean } & CommandOutput)
  | ({ status: "direct"; exitCode: number } & CommandOutput)
  | ({ status: "running" } & CommandOutput)
  | ({ status: "lost" } & CommandOutput)
  | { status: "unknown" }
  | { status: "unconfirmed" }

/** Reads the state of process `$pid` into `$state`, false when there is none; `Z` is one that ended and awaits its parent. */
const PROCESS_STATE = `read -r _pid _name state _rest 2>/dev/null < "/proc/$pid/stat"`

/** The name of a command's files: the same for the same call, so a later wait finds them; one of a kind without one. */
function commandJob(callKey?: string) {
  return `bash-call-${createHash("sha256").update(callKey ?? crypto.randomUUID()).digest("hex").slice(0, 24)}`
}

/**
 * Counts running jobs. `background` leaves its `.running` file empty until it removes it; a command's names its
 * process and the boot it belongs to, so a file left by a command that was killed, or by a restart, doesn't count.
 */
const RUNNING_JOBS = [
  `boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null); count=0`,
  `for file in ${JOBS_DIR}/*.running; do`,
  `  [ -e "$file" ] || continue`,
  `  pid=; at=; state=; read -r pid at 2>/dev/null < "$file"`,
  `  case "$pid" in`,
  `    ''|*[!0-9]*) count=$((count + 1)) ;;`,
  `    *) [ "$at" = "$boot" ] && ${PROCESS_STATE} && [ "$state" != Z ] && count=$((count + 1)) ;;`,
  `  esac`,
  `done`,
  `echo "$count"`,
].join("\n")

/**
 * Runs a command in its own session, so it outlives the request that started it: $1 its files, $2 its time limit in
 * seconds, $3 how many bytes of each stream to keep, $4 the command. Its output goes to `$1.out` and `$1.err`; when it
 * ends, `$1.exit` gets `<exit code> <1 when its limit stopped it> <stdout bytes> <stderr bytes>`.
 */
const COMMAND_RUNNER = [
  `echo "$$ $(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" > "$1.running.new" && mv "$1.running.new" "$1.running"`,
  `timeout -k ${STOP_GRACE_SECONDS} "$2" bash -c "$4" > "$1.out" 2> "$1.err" < /dev/null`,
  `code=$?; stopped=0; sizes=`,
  `case "$code" in 124|137) [ "$SECONDS" -ge "$2" ] && stopped=1 ;; esac`,
  `for stream in out err; do`,
  `  size=$(wc -c < "$1.$stream"); sizes="$sizes $size"`,
  `  [ "$size" -gt "$3" ] && tail -c "$3" "$1.$stream" > "$1.$stream.new" && mv "$1.$stream.new" "$1.$stream"`,
  `done`,
  `echo "$code $stopped$sizes" > "$1.exit.new" && mv "$1.exit.new" "$1.exit"`,
  `rm -f "$1.running"`,
].join("\n")

/**
 * What one request for a command runs: with `start`, it starts the command unless the computer already has it, then
 * it waits up to `waitSeconds` for the command to end. It prints `<marker> <status> <exit code> <stopped> <stdout
 * bytes> <stderr bytes>`, then the end of the command's stdout, with the end of its stderr on stderr.
 */
function commandScript(job: string, waitSeconds: number, start?: { command: string; limitSeconds: number }) {
  return [
    `job=${shellQuote(`${JOBS_DIR}/${job}`)}; boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)`,
    ...(start ? [
      `run=${shellQuote(start.command)}`,
      `mkdir -p ${JOBS_DIR} 2>/dev/null`,
      // Making its output file is what claims a command, and a file can be made once: it never starts twice.
      `if ( set -C; : > "$job.out" ) 2>/dev/null; then`,
      `  find ${JOBS_DIR} -maxdepth 1 -name 'bash-call-*' -mmin +${COMMAND_KEPT_MINUTES} -delete 2>/dev/null`,
      `  echo "$$ $boot" > "$job.running"`,
      `  setsid nohup bash -c ${shellQuote(COMMAND_RUNNER)} _ "$job" ${start.limitSeconds} ${OUTPUT_TAIL_BYTES} "$run" > /dev/null 2>&1 < /dev/null &`,
      // Nowhere to keep its files (a full disk): it runs inside this request, as commands did before.
      `elif [ ! -e "$job.out" ]; then exec bash -c "$run"`,
      `fi`,
    ] : []),
    `look() {`,
    `  status=done; [ -e "$job.exit" ] && return`,
    `  status=running; pid=; at=; state=; read -r pid at 2>/dev/null < "$job.running"`,
    `  [ -n "$pid" ] && [ "$at" = "$boot" ] && ${PROCESS_STATE} && [ "$state" != Z ] && return`,
    // It may have ended between the two looks.
    `  status=done; [ -e "$job.exit" ] && return`,
    `  status=lost; [ -e "$job.out" ] && return`,
    `  status=unknown`,
    `}`,
    `look; end=$((SECONDS + ${waitSeconds}))`,
    `while [ "$status" = running ] && [ "$SECONDS" -lt "$end" ]; do`,
    // Looks often at first, so a quick command isn't held up, then less and less.
    `  if [ "$SECONDS" -lt 1 ]; then sleep 0.01; elif [ "$SECONDS" -lt 10 ]; then sleep 0.05; else sleep 0.25; fi`,
    `  look`,
    `done`,
    `code=0; stopped=0; out=0; err=0`,
    `if [ "$status" = done ]; then read -r code stopped out err < "$job.exit"`,
    `elif [ "$status" != unknown ]; then out=$(wc -c 2>/dev/null < "$job.out"); err=$(wc -c 2>/dev/null < "$job.err"); fi`,
    'echo "' + COMMAND_MARKER + ' $status ${code:-0} ${stopped:-0} ${out:-0} ${err:-0}"',
    `if [ "$status" != unknown ]; then tail -c ${OUTPUT_TAIL_BYTES} "$job.out" 2>/dev/null; [ -e "$job.err" ] && tail -c ${OUTPUT_TAIL_BYTES} "$job.err" >&2; fi`,
    `exit 0`,
  ].join("\n")
}

/** What a request for a command answered. Without `commandScript`'s first line, the command ran inside the request. */
function readCommand(result: { exitCode: number; stdout?: string; stderr?: string }): CommandOutcome {
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""
  if (!stdout.startsWith(`${COMMAND_MARKER} `)) return { status: "direct", exitCode: result.exitCode, stdout: tail(stdout), stderr: stderr.trim() ? tail(stderr) : "" }
  const lineEnd = stdout.indexOf("\n")
  const [, status, code, stopped, outBytes, errBytes] = stdout.slice(0, lineEnd === -1 ? stdout.length : lineEnd).split(" ")
  if (status !== "done" && status !== "running" && status !== "lost") return { status: "unknown" }
  // What the computer dropped before the end it kept, so the note on what was cut still counts all of it.
  const dropped = (bytes: string | undefined) => Math.max(0, (Number(bytes) || 0) - OUTPUT_TAIL_BYTES)
  const output = { stdout: tail(lineEnd === -1 ? "" : stdout.slice(lineEnd + 1), dropped(outBytes)), stderr: stderr.trim() ? tail(stderr, dropped(errBytes)) : "" }
  if (status !== "done") return { status, ...output }
  const exitCode = Number(code)
  return Number.isInteger(exitCode) && code !== "" ? { status, exitCode, stopped: stopped === "1", ...output } : { status: "lost", ...output }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export const COMPUTER_TOOL_NAMES: ReadonlySet<string> = new Set(["bash", "look"])

export const COMPUTER_TOOLS: ToolSpec[] = [
  {
    name: "bash",
    description: [
      "Run a shell command on your Linux computer for this conversation (Ubuntu, internet access; administrative commands depend on the image policy).",
      `The working directory is ${WORKSPACE}; everything there persists between messages.`,
      `Files the person sends are copied to ${FILES_DIR}. Anything you write to ${OUT_DIR} is added to their Files after the command.`,
      "Installed: python3 (pandas, numpy, matplotlib, openpyxl, xlsxwriter, python-docx, python-pptx, pdfplumber, pypdf, pillow, opencv), ffmpeg, imagemagick, poppler-utils, qpdf, tesseract, pandoc, node, jq, ripgrep, sqlite3, git, curl. There is no general administrative access: install system packages with \`sudo openwork-install <package>...\` (package names only, from the image's repositories) and Python libraries in a virtual environment.",
      `A command times out after timeout_seconds (at most ${MAX_COMMAND_SECONDS}). For longer work run \`background <name> '<command>'\` and check \`tail -n 20 ${WORKSPACE}/.jobs/<name>.log\`.`,
      "Always set description first: it is the progress update the person sees.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description:
            "The update the person sees while this runs: what you are doing for them, in a few plain words, with no commands, file paths or tool names. For example \"Pulling a few frames from your video\", \"Turning the recording into a GIF\", \"Adding up the totals in your spreadsheet\".",
        },
        command: { type: "string", description: "The command, run with bash -c." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_COMMAND_SECONDS },
      },
      required: ["description", "command"],
      additionalProperties: false,
    },
  },
  {
    name: "look",
    description:
      "Look at files on your computer: images and PDFs as they are, Word, Excel and PowerPoint as text, text files as text. Pass up to 4 paths at once. To see a video, extract frames with ffmpeg first and look at those.",
    inputSchema: {
      type: "object",
      properties: { paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 } },
      required: ["paths"],
      additionalProperties: false,
    },
  },
]

export const COMPUTER_PROMPT = `- You have a Linux computer for this conversation (the bash and look tools). Use it whenever a task needs real programs: video, audio, images, spreadsheets, charts, PDFs, data, code. Files the person sends are in ${FILES_DIR}; put files you make for them in ${OUT_DIR} and they appear in their Files. Look at your results before describing them. Don't mention paths, commands or the computer unless it helps them.`

const bashInput = z.object({
  command: z.string().min(1),
  description: z.string().optional(),
  timeout_seconds: z.number().int().min(1).max(MAX_COMMAND_SECONDS).optional(),
})
const lookInput = z.object({ paths: z.array(z.string().min(1)).min(1).max(4) })

async function runComputerTool(computers: Computers, sessionId: string, name: string, input: Record<string, unknown>, callKey?: string): Promise<ToolResult> {
  if (name === "bash") {
    const parsed = bashInput.safeParse(input)
    if (!parsed.success) return { output: "bash needs a command (and optionally timeout_seconds up to 300).", isError: true }
    return computers.bash(sessionId, parsed.data.command, parsed.data.timeout_seconds ?? DEFAULT_COMMAND_SECONDS, callKey)
  }
  if (name === "look") {
    const parsed = lookInput.safeParse(input)
    if (!parsed.success) return { output: "look needs paths: 1 to 4 file paths.", isError: true }
    return computers.look(sessionId, parsed.data.paths)
  }
  return { output: `Unknown tool: ${name}`, isError: true }
}
