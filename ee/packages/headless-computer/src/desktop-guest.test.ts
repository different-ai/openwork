import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { networkInterfaces, tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { WebSocket } from "ws"

/** The guest's server and tickets stay real; the desktop it drives is replaced by stand-ins. */
const stubs: Record<string, string> = {
  "@openwork/computer-use/cloud": "export const createCloudComputer = async () => ({ snapshot: async () => ({ paused: false }), interact: async () => {}, close: async () => {} }); export const browserEgressStatus = async () => ({});",
  "@openwork/computer-use/browser-demonstration": "export const createBrowserDemonstration = () => ({ isTeaching: () => false });",
  "./desktop-apps.mjs": "export const createDesktopApplications = () => ({});",
  "./browser-screencast.mjs": "export const streamBrowser = (ws) => { ws.send('frame'); return () => {}; };",
}

const origin = "https://chat.example"

/** The bundled guest running on this machine, with the secret its helper would hold. */
async function startGuest() {
  const directory = await mkdtemp(join(tmpdir(), "desktop-guest-"))
  const outfile = join(directory, "guest.mjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./desktop-guest.mjs", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    plugins: [{ name: "desktop-stubs", setup(plugin) {
      plugin.onResolve({ filter: /./ }, args => args.path in stubs ? { path: args.path, namespace: "desktop-stub" } : undefined)
      plugin.onLoad({ filter: /./, namespace: "desktop-stub" }, args => ({ contents: stubs[args.path], loader: "js" }))
    } }],
  })
  const secret = "test-bearer"
  await writeFile(join(directory, "token"), secret)
  const guest = spawn(process.execPath, [outfile], { env: { ...process.env, WORKBOT_DESKTOP_STATE: directory }, stdio: ["ignore", "ignore", "pipe"] })
  let errors = ""
  guest.stderr.on("data", chunk => { errors += chunk })
  const ticket = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch("http://127.0.0.1:6080/viewer", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ view: "browser", origin }) }).catch(() => null)
      if (response?.ok) return (await response.json() as { token: string }).token
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`The guest never served a viewer ticket. ${errors}`)
  }
  const stop = async () => {
    guest.kill()
    await rm(directory, { recursive: true, force: true })
  }
  return { guest, secret, ticket, stop, errors: () => errors }
}

test("the desktop guest keeps serving after viewers open the page stream and VNC", async () => {
  const { guest, ticket, stop, errors } = await startGuest()
  try {
    const stream = new WebSocket(`ws://127.0.0.1:6080/screencast/${await ticket()}`, { origin })
    const frame = await new Promise((resolve, reject) => {
      stream.once("message", resolve)
      stream.once("close", () => reject(new Error(`The page stream closed before its first frame. ${errors()}`)))
    })
    assert.equal(String(frame), "frame")
    stream.close()
    // No VNC helper exists here, so the guest closes this viewer itself; it must not take the guest down with it.
    const vnc = new WebSocket(`ws://127.0.0.1:6080/vnc/${await ticket()}`, { origin })
    await once(vnc, "open")
    await once(vnc, "close")
    assert.ok(await ticket(), "the guest still issues viewer tickets")
    assert.equal(guest.exitCode, null, errors())
  } finally {
    await stop()
  }
})

test("the desktop guest refuses its secret from outside the computer", async (t) => {
  const { secret, ticket, stop } = await startGuest()
  /** The status of a viewer request sent to `address` and naming `host`, with the right secret. */
  const post = (address: string, host: string) => new Promise<number>((resolve, reject) => {
    const request = httpRequest({ host: address, port: 6080, path: "/viewer", method: "POST", headers: { host, authorization: `Bearer ${secret}` } }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on("error", reject)
    request.end(JSON.stringify({ view: "browser", origin }))
  })
  try {
    await ticket()
    assert.equal(await post("127.0.0.1", "127.0.0.1:6080"), 200, "the helper on the computer is served")
    // Through the computer's public address, as a proxy running on the computer would deliver it.
    assert.equal(await post("127.0.0.1", "0123456789abcdef01234567-6080.example.dev"), 404)
    const outside = Object.values(networkInterfaces()).flat().find(entry => entry?.family === "IPv4" && !entry.internal)?.address
    if (outside) assert.equal(await post(outside, "127.0.0.1:6080"), 404)
    else t.diagnostic("No outside address on this machine: only the public host name was checked.")
  } finally {
    await stop()
  }
})
