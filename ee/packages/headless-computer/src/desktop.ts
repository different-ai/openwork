/// <reference path="./desktop-assets.d.ts" />
import identity from "../dist/desktop-identity.mjs"
import guestBundle from "../dist/desktop-guest-bundle.mjs"
import { createHash, randomUUID } from "node:crypto"
import { shellQuote, type SandboxHandle, type SandboxProvider } from "@openwork/sandbox"
import { z } from "zod"
import { DESKTOP_PROTOCOL } from "./desktop-protocol.mjs"

const BRIDGE = "/usr/local/sbin/openwork-desktop-bridge"
/** Files the runner hands the helper live in the provider account's home, which only that account can write. */
const UPLOADS = "/home/ubuntu"
/** The most either carried archive may be (desktop-bridge.py's MAX_CARRIED_BYTES). */
const MAX_CARRIED_BYTES = 100 * 1024 * 1024
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
  /** Health versions of desktops already found stale but compatible, by computer, so they aren't checked again. */
  private readonly compatible = new Map<string, string>()
  /** The image this runner's computers boot from. */
  readonly image = identity.image.trim()
  private readonly guest = identity.guest.trim()
  /** privateBrowsing lets the browser open loopback and private pages: operator diagnostics on a dedicated VM only. */
  constructor(private readonly provider: SandboxProvider, private readonly options: { privateBrowsing?: boolean } = {}) {}

  start(box: SandboxHandle): Promise<DesktopState> {
    const key = JSON.stringify(box.ref)
    let pending = this.starting.get(key)
    if (!pending) {
      pending = this.prepare(box, key).finally(() => this.starting.delete(key))
      this.starting.set(key, pending)
    }
    return pending
  }

  private async prepare(box: SandboxHandle, key: string): Promise<DesktopState> {
    const { run } = this.provider.blocks ?? {}
    if (!run || this.provider.describe().platform?.os !== "linux") throw new Error("Desktop access needs a configured Linux computer.")
    const privateBrowsing = this.options.privateBrowsing === true
    const version = createHash("sha256").update(identity.image).update(identity.guest).update(privateBrowsing ? "private-browsing" : "").digest("hex")
    const ready = await this.health(box)
    if (ready?.version === version) return "current"
    if (ready && this.compatible.get(key) === ready.version) return "stale"
    let started = await this.launch(box, this.image, this.guest)
    // Same image, older guest: install this runner's guest into the running computer instead of replacing it.
    if (!started.ok && /guest is out of date/i.test(started.detail)) {
      await this.install(box)
      started = await this.launch(box, this.image, this.guest)
    }
    if (started.ok) {
      await this.healthy(box)
      return "current"
    }
    // A helper from before images and guests had their own identities refuses two of them; another image says so.
    if (!/out of date|start VERSION/i.test(started.detail)) {
      throw new Error(`The computer needs a desktop snapshot built for this runner, including its restricted desktop helper.${started.detail ? ` ${started.detail}` : ""}`)
    }
    // Another image: keep driving its own desktop while it speaks this runner's protocol.
    let own = ready
    if (!own) {
      const versions = await this.versions(box)
      if (versions && (await this.launch(box, versions.image, versions.guest)).ok) own = await this.healthy(box)
    }
    if (own?.protocol === DESKTOP_PROTOCOL) {
      this.compatible.set(key, own.version)
      return "stale"
    }
    throw new DesktopError("desktop_outdated", `The computer's desktop image was built for a different runner: ${started.detail}`)
  }

  private async health(box: SandboxHandle) {
    const parsed = healthSchema.safeParse(await this.call(box, "/health", {}).catch(() => null))
    return parsed.success ? parsed.data : null
  }

  private async healthy(box: SandboxHandle) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const probe = await this.health(box)
      if (probe) return probe
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new DesktopError("desktop_unresponsive", "The desktop didn't respond. Try reconnecting.")
  }

  private async launch(box: SandboxHandle, image: string, guest: string) {
    const result = await this.bridge(box, `start ${image} ${guest}`, 45_000)
    return { ok: result.exitCode === 0, detail: result.stderr.trim().slice(0, 300) }
  }

  /** The image and guest this computer was built with, or null from a helper that predates in-place updates. */
  async versions(box: SandboxHandle) {
    const result = await this.bridge(box, "versions", 10_000).catch(() => null)
    const parsed = result?.exitCode === 0 ? versionsSchema.safeParse(safeJson(result.stdout)) : null
    return parsed?.success ? parsed.data : null
  }

  /** Hands the helper this runner's guest bundle; it checks the checksum and that the image is its own. */
  private async install(box: SandboxHandle) {
    const result = await this.upload(box, Buffer.from(guestBundle, "base64"), path =>
      this.bridge(box, `install ${this.image} ${this.guest} ${identity.bundleSha256} < ${path}`, 60_000))
    if (result.exitCode !== 0) throw new Error(`Couldn't update the computer's desktop. ${result.stderr.trim().slice(0, 300)}`)
  }

  /** The browser profile or workspace as a gzipped tar, or null when this computer can't export it (or it's too big). */
  async exportState(box: SandboxHandle, name: CarriedState): Promise<Uint8Array | null> {
    const { files, run } = this.provider.blocks ?? {}
    if (!files || !run) return null
    const path = `${UPLOADS}/.openwork-carried-${randomUUID()}`
    try {
      const result = await this.bridge(box, `export ${name} > ${path}`, 240_000)
      if (result.exitCode === 0) return await files.read(box, path, { timeoutMs: 120_000 })
      // A helper from before carrying existed: the provider account can still pack the shared workspace itself (the
      // browser's profile is private to the browser's account).
      if (name !== "workspace" || !/start VERSION/i.test(result.stderr)) return null
      const packed = await run(box, { command: `tar -czf ${path} -C /workspace --exclude=./files --exclude='./.jobs/*.running' --ignore-failed-read . 2>/dev/null; [ $? -le 1 ]`, timeoutMs: 240_000 })
      const size = packed.exitCode === 0 ? (await files.stat(box, path, { timeoutMs: 10_000 }))?.size : undefined
      return size !== undefined && size <= MAX_CARRIED_BYTES ? await files.read(box, path, { timeoutMs: 120_000 }) : null
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

  private async upload<T>(box: SandboxHandle, bytes: Uint8Array, use: (path: string) => Promise<T>): Promise<T> {
    const files = this.provider.blocks?.files
    if (!files) throw new Error("This computer can't receive files.")
    const path = `${UPLOADS}/.openwork-upload-${randomUUID()}`
    await files.write(box, path, bytes, { timeoutMs: 120_000 })
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
