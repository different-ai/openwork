/// <reference path="./desktop-assets.d.ts" />
import identity from "../dist/desktop-identity.mjs"
import guestBundle from "../dist/desktop-guest-bundle.mjs"
import { createHash, randomUUID } from "node:crypto"
import { isSandboxError, shellQuote, type SandboxHandle, type SandboxProvider } from "@openwork/sandbox"
import { z } from "zod"
import { DESKTOP_PROTOCOL } from "./desktop-protocol.mjs"

const BRIDGE = "/usr/local/sbin/openwork-desktop-bridge"
/** Files the runner hands the helper live in the provider account's home, which only that account can write. */
const UPLOADS = "/home/ubuntu"
/**
 * On a replacement that came up on an older image: the image it was made for and when. On the computer itself because
 * the process that made it rarely outlasts an idle chat.
 */
const REPLACED_NOTE = `${UPLOADS}/.openwork-replaced-on-older-image`
/** The most either carried archive may be (desktop-bridge.py's MAX_CARRIED_BYTES). */
const MAX_CARRIED_BYTES = 100 * 1024 * 1024
/**
 * How long a desktop gets to start, across every step. The steps' own limits add up to minutes, and a computer that
 * needs them all isn't going to start: the sooner that is known, the sooner it can be replaced.
 */
const START_BUDGET_MS = 40_000
/** One look at the desktop, run inside the computer. */
const HEALTH = `printf %s '{}' | sudo -n ${BRIDGE} call '/health'`
/** What a start command exits with when the desktop started and then never answered. */
const STARTED_SILENT = 75
const viewerSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), paused: z.boolean() })
const healthSchema = z.object({ version: z.string(), protocol: z.number().optional() }).loose()
const versionsSchema = z.object({ image: z.string().regex(/^[a-f0-9]{64}$/), guest: z.string().regex(/^[a-f0-9]{64}$/) })
export type DesktopView = "browser" | "computer"
/**
 * `current`: the computer runs this runner's image and guest. `stale`: it was built from another image whose desktop
 * still speaks this runner's protocol, so it keeps working until it can be replaced.
 */
export type DesktopState = "current" | "stale"
/** What a replacement computer carries over from the one it replaces (desktop-bridge.py). */
export type CarriedState = "profile" | "workspace"

/**
 * Why a desktop could not start, as a stable code the runner reports and Workbot turns into its own words.
 * `desktop_outdated`: the computer's image can't serve this runner, so the computer has to be replaced.
 * `desktop_updating`: it is being replaced, or will be once the work running on it finishes.
 */
export class DesktopError extends Error {
  constructor(readonly desktopCode: "desktop_outdated" | "desktop_unresponsive" | "desktop_updating", message: string) { super(message) }
}

/** The existing conversation computer owns the desktop too; it never provisions a second machine. */
export class Desktop {
  private readonly starting = new Map<string, Promise<DesktopState>>()
  /** The guest install under way for each computer, which a start and an idle update that overlap share. */
  private readonly installing = new Map<string, Promise<void>>()
  /** Health versions of desktops already found stale but compatible, by computer, so they aren't checked again. */
  private readonly compatible = new Map<string, string>()
  /** The image this runner's computers boot from. */
  readonly image = identity.image.trim()
  /** The guest this runner installs into a computer built from its image. */
  readonly guest = identity.guest.trim()
  /** What a desktop on this runner's image and guest answers a health check with. */
  private readonly version: string
  /** privateBrowsing lets the browser open loopback and private pages: operator diagnostics on a dedicated VM only. */
  constructor(private readonly provider: SandboxProvider, options: { privateBrowsing?: boolean } = {}) {
    this.version = createHash("sha256").update(identity.image).update(identity.guest).update(options.privateBrowsing === true ? "private-browsing" : "").digest("hex")
  }

  start(box: SandboxHandle): Promise<DesktopState> {
    const key = JSON.stringify(box.ref)
    let pending = this.starting.get(key)
    if (!pending) {
      pending = this.prepare(box, key).finally(() => this.starting.delete(key))
      this.starting.set(key, pending)
    }
    return pending
  }

  /**
   * Brings an idle computer on this runner's image up to this runner's guest, so the next use of its desktop doesn't
   * wait for that. A desktop that is running restarts on the new guest, as that next use would have made it; one that
   * isn't only gets the guest, and starts when it is first needed. Returns whether anything changed.
   */
  async update(box: SandboxHandle) {
    const { health, built } = await this.look(box)
    if (built?.image !== this.image || built.guest === this.guest) return false
    if (health) await this.start(box)
    else await this.install(box, START_BUDGET_MS)
    return true
  }

  private async prepare(box: SandboxHandle, key: string): Promise<DesktopState> {
    const { run } = this.provider.blocks ?? {}
    if (!run || this.provider.describe().platform?.os !== "linux") throw new Error("Desktop access needs a configured Linux computer.")
    const deadline = Date.now() + START_BUDGET_MS
    /** What a step may take: its own limit, or what is left of the start's time. */
    const within = (limit: number) => {
      const left = deadline - Date.now()
      if (left < 1_000) throw new DesktopError("desktop_unresponsive", "The computer's desktop didn't start. Try reconnecting.")
      return Math.min(limit, left)
    }
    const { health: ready, built } = await this.look(box)
    if (ready?.version === this.version) return "current"
    if (ready && this.compatible.get(key) === ready.version) return "stale"
    // A start the helper is known to refuse is never run: another image keeps its own desktop (below).
    let refusal = "The desktop image is out of date. Rebuild its snapshot for this runner."
    if (!built || built.image === this.image) {
      // Same image, older guest: install this runner's guest into the running computer instead of replacing it, then
      // start once.
      const behind = built !== null && built.guest !== this.guest
      if (behind) await this.install(box, within(60_000))
      let started = await this.launch(box, this.image, this.guest, within(45_000))
      // A computer that couldn't say what it was built with says so by refusing.
      if (!behind && !started.ok && /guest is out of date/i.test(started.detail)) {
        await this.install(box, within(60_000))
        started = await this.launch(box, this.image, this.guest, within(45_000))
      }
      if (!started.ok && started.timedOut) {
        // A timeout can leave startup running: only recheck health, never automatically replay start.
        if ((await this.look(box)).health?.version === this.version) return "current"
      }
      if (started.ok) return "current"
      // A helper from before images and guests had their own identities refuses two of them; another image says so.
      if (!/out of date|start VERSION/i.test(started.detail)) {
        if (started.missingHelper) {
          throw new Error(`The computer needs a desktop snapshot built for this runner, including its restricted desktop helper. ${started.detail}`)
        }
        throw new DesktopError("desktop_unresponsive", `The computer's desktop didn't start. Try reconnecting.${started.detail ? ` ${started.detail}` : ""}`)
      }
      refusal = started.detail
    }
    // Another image: keep driving its own desktop while it speaks this runner's protocol.
    let own = ready
    if (!own) {
      const versions = built ?? await this.versions(box)
      if (versions) own = (await this.launch(box, versions.image, versions.guest, within(45_000))).health
    }
    if (own?.protocol === DESKTOP_PROTOCOL) {
      this.compatible.set(key, own.version)
      return "stale"
    }
    throw new DesktopError("desktop_outdated", `The computer's desktop image was built for a different runner: ${refusal}`)
  }

  /**
   * What the desktop answers and, unless that is this runner's version, the image and guest the computer was built
   * with: one command, so a start knows what the helper would refuse without asking it.
   */
  private async look(box: SandboxHandle) {
    const result = await this.provider.blocks?.run?.(box, {
      command: `health=$(${HEALTH}); printf '%s\\n' "$health"; case "$health" in *${this.version}*) ;; *) sudo -n ${BRIDGE} versions ;; esac`,
      timeoutMs: 12_000,
    }).catch(() => null)
    const [answered = "", versions = ""] = (result?.stdout ?? "").split("\n")
    const health = healthSchema.safeParse(safeJson(answered))
    const built = versionsSchema.safeParse(safeJson(versions))
    return { health: health.success ? health.data : null, built: built.success ? built.data : null }
  }

  /**
   * Starts the desktop built from `image` and `guest` and waits inside the computer for it to answer, all in one
   * command: asking from here costs a round trip per look, and a browser takes several to come up.
   */
  private async launch(box: SandboxHandle, image: string, guest: string, timeoutMs: number) {
    // The computer gives up a little before the command's own limit, so a desktop that never answers is told apart
    // from a command whose outcome is unknown.
    const seconds = Math.max(1, Math.floor(timeoutMs / 1000) - 3)
    const wait = `end=$(($(date +%s) + ${seconds})); until health=$(${HEALTH} 2>/dev/null); do [ "$(date +%s)" -lt "$end" ] || exit ${STARTED_SILENT}; sleep 0.1; done; printf '%s\\n' "$health"`
    let result
    try { result = await this.bridge(box, `start ${image} ${guest} || exit; ${wait}`, timeoutMs) }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, health: null, detail: detail.slice(0, 300), timedOut: (isSandboxError(error) && error.code === "timeout") || /timed?\s*out|timeout/i.test(detail), missingHelper: false }
    }
    if (result.exitCode === STARTED_SILENT) throw new DesktopError("desktop_unresponsive", "The desktop didn't respond. Try reconnecting.")
    const detail = result.stderr.trim()
    const health = result.exitCode === 0 ? healthSchema.safeParse(safeJson(result.stdout.trim().split("\n").at(-1) ?? "")) : null
    return {
      ok: result.exitCode === 0,
      health: health?.success ? health.data : null,
      detail: detail.slice(0, 300),
      timedOut: /timed?\s*out|timeout/i.test(detail),
      missingHelper: detail.includes(BRIDGE) && /command not found|no such file or directory|not found/i.test(detail),
    }
  }

  /** The image and guest this computer was built with, or null from a helper that predates in-place updates. */
  async versions(box: SandboxHandle) {
    const result = await this.bridge(box, "versions", 10_000).catch(() => null)
    const parsed = result?.exitCode === 0 ? versionsSchema.safeParse(safeJson(result.stdout)) : null
    return parsed?.success ? parsed.data : null
  }

  /** Notes on `box`, a replacement made just now, that it came up on an older image than this runner's. */
  async noteReplacement(box: SandboxHandle) {
    const versions = await this.versions(box)
    if (versions && versions.image !== this.image) await this.provider.blocks?.run?.(box, { command: `echo ${this.image} ${Date.now()} > ${REPLACED_NOTE}`, activity: "maintenance", timeoutMs: 10_000 })
  }

  /** Whether `box` came up on an older image within the last `withinMs` when replaced for this runner's: another try would gain nothing. */
  async replacedInVain(box: SandboxHandle, withinMs: number) {
    const note = await this.provider.blocks?.run?.(box, { command: `cat ${REPLACED_NOTE} 2>/dev/null`, activity: "maintenance", timeoutMs: 10_000 }).catch(() => null)
    const [image, at] = note?.stdout.trim().split(" ") ?? []
    return image === this.image && Date.now() - Number(at) < withinMs
  }

  /**
   * Hands the helper this runner's guest bundle; it checks the checksum and that the image is its own. One at a time
   * per computer: the helper writes the bundle in place, so two installs at once could leave half of one.
   */
  private install(box: SandboxHandle, timeoutMs: number) {
    const key = JSON.stringify(box.ref)
    let pending = this.installing.get(key)
    if (!pending) {
      pending = this.upload(box, Buffer.from(guestBundle, "base64"), path =>
        this.bridge(box, `install ${this.image} ${this.guest} ${identity.bundleSha256} < ${path}`, timeoutMs), timeoutMs)
        .then(result => { if (result.exitCode !== 0) throw new Error(`Couldn't update the computer's desktop. ${result.stderr.trim().slice(0, 300)}`) })
        .finally(() => this.installing.delete(key))
      this.installing.set(key, pending)
    }
    return pending
  }

  /** The browser profile or workspace as a gzipped tar, or null when this computer can't export it in time (or it's too big). */
  async exportState(box: SandboxHandle, name: CarriedState, timeoutMs = 240_000): Promise<Uint8Array | null> {
    const { files, run } = this.provider.blocks ?? {}
    if (!files || !run) return null
    const path = `${UPLOADS}/.openwork-carried-${randomUUID()}`
    try {
      const result = await this.bridge(box, `export ${name} > ${path}`, timeoutMs)
      if (result.exitCode === 0) return await files.read(box, path, { timeoutMs: Math.min(120_000, timeoutMs) })
      // A helper from before carrying existed: the provider account can still pack the shared workspace itself (the
      // browser's profile is private to the browser's account).
      if (name !== "workspace" || !/start VERSION/i.test(result.stderr)) return null
      const packed = await run(box, { command: `tar -czf ${path} -C /workspace --exclude=./files --exclude='./.jobs/*.running' --ignore-failed-read . 2>/dev/null; [ $? -le 1 ]`, timeoutMs })
      const size = packed.exitCode === 0 ? (await files.stat(box, path, { timeoutMs: 10_000 }))?.size : undefined
      return size !== undefined && size <= MAX_CARRIED_BYTES ? await files.read(box, path, { timeoutMs: Math.min(120_000, timeoutMs) }) : null
    } finally {
      await this.provider.blocks?.run?.(box, { command: `rm -f ${path}`, activity: "maintenance", timeoutMs: 10_000 }).catch(() => undefined)
    }
  }

  /** Unpacks state another computer exported. Importing a profile closes the browser; `start` opens it again. */
  async importState(box: SandboxHandle, name: CarriedState, bytes: Uint8Array) {
    const result = await this.upload(box, bytes, path => this.bridge(box, `import ${name} < ${path}`, 240_000))
    if (result.exitCode !== 0) throw new Error(`Couldn't carry the ${name} over. ${result.stderr.trim().slice(0, 300)}`)
    this.compatible.delete(JSON.stringify(box.ref))
  }

  private async upload<T>(box: SandboxHandle, bytes: Uint8Array, use: (path: string) => Promise<T>, timeoutMs = 120_000): Promise<T> {
    const files = this.provider.blocks?.files
    if (!files) throw new Error("This computer can't receive files.")
    const path = `${UPLOADS}/.openwork-upload-${randomUUID()}`
    await files.write(box, path, bytes, { timeoutMs })
    try { return await use(path) }
    finally { await this.provider.blocks?.run?.(box, { command: `rm -f ${path}`, activity: "maintenance", timeoutMs: 10_000 }).catch(() => undefined) }
  }

  private bridge(box: SandboxHandle, args: string, timeoutMs: number) {
    const run = this.provider.blocks?.run
    if (!run) throw new Error("Desktop access is unavailable.")
    return run(box, { command: `sudo -n ${BRIDGE} ${args}`, timeoutMs })
  }

  async call(box: SandboxHandle, path: string, body: unknown): Promise<unknown> {
    const run = this.provider.blocks?.run
    if (!run) throw new Error("Desktop access is unavailable.")
    const seconds = path === "/health" ? 4 : path === "/stop" ? 10 : 125
    const result = await run(box, {
      command: `printf %s ${shellQuote(JSON.stringify(body))} | sudo -n ${BRIDGE} call ${shellQuote(path)}`,
      timeoutMs: (seconds + 5) * 1000,
    })
    if (result.exitCode !== 0) throw new Error("The desktop operation didn't finish. Check the view before retrying.")
    return JSON.parse(result.stdout)
  }

  /** A viewer ticket for a desktop the caller has started. */
  async viewer(box: SandboxHandle, input: { view: DesktopView; control: boolean; origin: string }) {
    const ticket = viewerSchema.parse(await this.call(box, "/viewer", input))
    const endpoint = await this.provider.endpoint(box, 6080, { ttlSeconds: 75 })
    const url = new URL(endpoint.url)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.pathname = `${url.pathname.replace(/\/$/, "")}/vnc/${ticket.token}`
    return { url: url.toString(), expiresAt: Date.now() + 60_000, paused: ticket.paused }
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}
