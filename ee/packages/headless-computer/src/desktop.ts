import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { shellQuote, type SandboxHandle, type SandboxProvider } from "@openwork/sandbox"
import { z } from "zod"

const STATE = "/workspace/.openwork-desktop"
const viewerSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), paused: z.boolean() })
export type DesktopView = "browser" | "computer"

/** The existing conversation computer owns the desktop too; it never provisions a second machine. */
export class Desktop {
  private readonly starting = new Map<string, Promise<void>>()
  constructor(private readonly provider: SandboxProvider) {}

  start(box: SandboxHandle): Promise<void> {
    const key = JSON.stringify(box.ref)
    let pending = this.starting.get(key)
    if (!pending) {
      pending = this.prepare(box).finally(() => this.starting.delete(key))
      this.starting.set(key, pending)
    }
    return pending
  }

  private async prepare(box: SandboxHandle) {
    const { run, files } = this.provider.blocks ?? {}
    if (!run || !files || this.provider.describe().platform?.os !== "linux") throw new Error("Desktop access needs a configured Linux computer.")
    const [guest, helper] = await Promise.all([
      readFile(new URL("../dist/desktop-guest.mjs", import.meta.url)),
      readFile(new URL("../dist/cloud-desktop.sh", import.meta.url)),
    ])
    const version = createHash("sha256").update(guest).update(helper).digest("hex")
    const ready = await run(box, { command: `sudo test -s ${STATE}/token && sudo curl -sf --max-time 2 -X POST -H "Authorization: Bearer $(sudo cat ${STATE}/token)" -d '{}' http://127.0.0.1:6080/health`, timeoutMs: 5_000 }).catch(() => ({ exitCode: 1, stdout: "{}" }))
    try { if (ready.exitCode === 0 && z.object({ version: z.literal(version) }).safeParse(JSON.parse(ready.stdout)).success) return }
    catch { /* A stale or unavailable guest is replaced below. */ }
    await run(box, { command: "sudo pkill -f '[/]workspace/.openwork-desktop/[g]uest.mjs' || true", timeoutMs: 5_000 })
    await run(box, { command: `mkdir -p ${STATE} && chmod 711 ${STATE}`, timeoutMs: 10_000 })
    await files.write(box, `${STATE}/guest.mjs`, guest, { timeoutMs: 15_000, mode: 0o600 })
    await files.write(box, `${STATE}/start.sh`, helper, { timeoutMs: 15_000, mode: 0o700 })
    const result = await run(box, {
      command: `sudo env WORKBOT_DESKTOP_VNC=1 sh ${STATE}/start.sh ${STATE} :99 && sudo env WORKBOT_DESKTOP_STATE=${STATE} WORKBOT_DESKTOP_VERSION=${version} DISPLAY=:99 XAUTHORITY=${STATE}/cloud-desktop/.Xauthority sh -c 'test -s ${STATE}/token || (umask 077; head -c 32 /dev/urandom | base64 > ${STATE}/token); setsid -f node ${STATE}/guest.mjs > ${STATE}/guest.log 2>&1 < /dev/null'`,
      timeoutMs: 30_000,
    })
    if (result.exitCode !== 0) throw new Error("The computer's snapshot needs Chromium, Xvfb, openbox, xdotool, ImageMagick, x11vnc and Node 22 or newer.")
    for (let attempt = 0; attempt < 30; attempt++) {
      const probe = await this.call(box, "/health", {}).catch(() => null)
      if (probe) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error("The desktop didn't respond. Try reconnecting.")
  }

  async call(box: SandboxHandle, path: string, body: unknown): Promise<unknown> {
    const run = this.provider.blocks?.run
    if (!run) throw new Error("Desktop access is unavailable.")
    const seconds = path === "/stop" ? 10 : 125
    const result = await run(box, {
      command: `sudo curl -sS --fail-with-body --max-time ${seconds} -X POST -H "Authorization: Bearer $(sudo cat ${STATE}/token)" -H 'Content-Type: application/json' --data ${shellQuote(JSON.stringify(body))} http://127.0.0.1:6080${path}`,
      timeoutMs: (seconds + 5) * 1000,
    })
    if (result.exitCode !== 0) throw new Error("The desktop operation didn't finish. Check the view before retrying.")
    return JSON.parse(result.stdout)
  }

  async viewer(box: SandboxHandle, input: { view: DesktopView; control: boolean; origin: string }) {
    await this.start(box)
    const ticket = viewerSchema.parse(await this.call(box, "/viewer", input))
    const endpoint = await this.provider.endpoint(box, 6080, { ttlSeconds: 75 })
    const url = new URL(endpoint.url)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.pathname = `${url.pathname.replace(/\/$/, "")}/vnc/${ticket.token}`
    return { url: url.toString(), expiresAt: Date.now() + 60_000, paused: ticket.paused }
  }
}
