/** Exercise the production desktop bridge on a dedicated, already-created CLI-authenticated Daytona VM. */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { gzipSync } from "node:zlib"
import assert from "node:assert/strict"
import { createFakeProvider } from "@openwork/sandbox/testing"
import { shellQuote } from "@openwork/sandbox"
import { WebSocket } from "ws"
import { Desktop } from "../src/desktop.js"

const sandbox = process.argv[2]
if (!sandbox) throw new Error("Pass a dedicated Daytona sandbox name; this check operates its desktop.")
const execute = promisify(execFile)
async function cli(args: string[]) {
  try { return (await execute("daytona", args, { maxBuffer: 8 * 1024 * 1024, timeout: 150_000 })).stdout }
  catch { throw new Error("Daytona proof command failed; inspect the owned sandbox.") }
}
const remote = (command: string) => cli(["exec", sandbox, "--timeout", "135", "--", `(${command}) 2>/dev/null`])
const fake = createFakeProvider()
const provider = {
  ...fake,
  describe: () => ({ ...fake.describe(), platform: { os: "linux" as const, isolation: "vm" as const } }),
  blocks: {
    ...fake.blocks,
    run: async (_box: unknown, input: { command: string }) => ({ exitCode: 0, stdout: await remote(input.command), stderr: "" }),
    files: {
      ...fake.blocks!.files!,
      write: async (_box: unknown, path: string, bytes: Uint8Array) => {
        const encoded = gzipSync(bytes).toString("base64")
        const upload = `${path}.proof-upload`
        await remote(`: > ${shellQuote(upload)}`)
        for (let offset = 0; offset < encoded.length; offset += 64 * 1024) {
          await remote(`printf %s ${shellQuote(encoded.slice(offset, offset + 64 * 1024))} >> ${shellQuote(upload)}`)
        }
        await remote(`base64 -d ${shellQuote(upload)} | gzip -d > ${shellQuote(path)}; rm ${shellQuote(upload)}`)
      },
    },
  },
  endpoint: async () => {
    const output = await cli(["preview-url", sandbox, "--port", "6080", "--expires", "75"])
    const url = output.match(/https:\/\/\S+/)?.[0]
    if (!url) throw new Error("Daytona returned no signed viewer URL.")
    return { url, expiresAt: new Date(Date.now() + 75_000), kind: "signed-expiring" as const }
  },
}
const desktop = new Desktop(provider)
const box = await fake.create({ idempotencyKey: "desktop-proof", image: null, labels: {}, env: {}, storage: [], exposePorts: [] }, { timeoutMs: 1000 })
await desktop.start(box)
const fixture = `/tmp/openwork-vnc-proof-${randomUUID()}`
const html = `<!doctype html><title>Workbot computer check</title><style>body{font:24px sans-serif;padding:60px}input,button{font:inherit;padding:12px}</style><h1>Workbot desktop</h1><label>Title <input id="entry"></label><button onclick="document.querySelector('#saved').textContent='Saved: '+document.querySelector('#entry').value">Save</button><p id="saved">Not saved</p>`
// Keep the fixture program constant; HTML and paths are data rather than JS source.
const fixtureSource = `const fs=require('node:fs'),path=require('node:path');const dir=process.argv[2];const server=require('node:http').createServer((_,res)=>res.end(fs.readFileSync(path.join(dir,'index.html'))));server.listen(0,'127.0.0.1',()=>fs.writeFileSync(path.join(dir,'port'),String(server.address().port)));fs.writeFileSync(path.join(dir,'pid'),String(process.pid));`
await remote(`mkdir -p ${fixture}; printf %s ${shellQuote(Buffer.from(html).toString("base64"))} | base64 -d > ${fixture}/index.html; printf %s ${shellQuote(Buffer.from(fixtureSource).toString("base64"))} | base64 -d > ${fixture}/server.cjs; setsid -f node ${fixture}/server.cjs ${shellQuote(fixture)} > ${fixture}/server.log 2>&1 < /dev/null; for n in 1 2 3 4 5 6 7 8 9 10; do test -s ${fixture}/port && break; sleep 0.1; done`)
const port = Number((await remote(`cat ${fixture}/port`)).trim())
assert.ok(Number.isInteger(port) && port > 0)
const browser = (operation: string, args: Record<string, unknown>) => desktop.call(box, "/browser/task", { sessionId: "vnc-proof", operation, args })
const opened = await browser("open", { url: `http://127.0.0.1:${port}/` })
assert.ok(typeof opened === "object" && opened !== null && "tabId" in opened)
const tabId = Reflect.get(opened, "tabId")

// First validate the exact RFB handshake over the signed, origin-bound WebSocket; never print its credentials.
for (const view of ["browser", "computer"] as const) {
  const ticket = await desktop.viewer(box, { view, control: false, origin: "http://localhost:3020" })
  const received = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(ticket.url, { origin: "http://localhost:3020" })
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("VNC handshake timed out")) }, 15_000)
    ws.once("message", data => { clearTimeout(timer); ws.close(); resolve(data.toString()) })
    ws.once("error", () => { clearTimeout(timer); reject(new Error("VNC WebSocket failed")) })
  })
  assert.match(received, /^RFB 003\./)
  const replay = await new Promise<boolean>(resolve => {
    const ws = new WebSocket(ticket.url, { origin: "http://localhost:3020" })
    ws.once("open", () => { ws.close(); resolve(false) }); ws.once("error", () => resolve(true))
  })
  assert.equal(replay, true)
}
const observation = z.object({ observationId: z.string(), elements: z.array(z.object({ ref: z.string(), name: z.string().optional() })), text: z.string() })
const see = async () => observation.parse(await browser("observe", { tabId }))
const fill = async (value: string) => {
  const seen = await see()
  const field = seen.elements.find(item => item.name === "Title")
  assert.ok(field)
  await browser("act", { tabId, observationId: seen.observationId, action: { type: "fill", ref: field.ref, text: value } })
}
async function keys(url: string, values: number[]) {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, { origin: "http://localhost:3020" })
    let buffer = Buffer.alloc(0), phase = 0
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("RFB input timed out")) }, 15_000)
    ws.on("error", () => { clearTimeout(timer); reject(new Error("RFB input failed")) })
    ws.on("message", data => {
      const chunk = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
      buffer = Buffer.concat([buffer, chunk])
      if (phase === 0 && buffer.length >= 12) { buffer = buffer.subarray(12); ws.send("RFB 003.008\n", { binary: true }); phase = 1 }
      if (phase === 1 && buffer.length >= 1 && buffer.length >= buffer[0] + 1) { assert.ok(buffer.subarray(1, buffer[0] + 1).includes(1)); buffer = buffer.subarray(buffer[0] + 1); ws.send(Buffer.from([1])); phase = 2 }
      if (phase === 2 && buffer.length >= 4) { assert.equal(buffer.readUInt32BE(0), 0); buffer = buffer.subarray(4); ws.send(Buffer.from([1])); phase = 3 }
      if (phase === 3 && buffer.length >= 24 && buffer.length >= 24 + buffer.readUInt32BE(20)) {
        assert.ok(buffer.readUInt16BE(0) > 640); assert.ok(buffer.readUInt16BE(2) > 400); phase = 4
        for (const value of values) for (const down of [1, 0]) { const event = Buffer.alloc(8); event[0] = 4; event[1] = down; event.writeUInt32BE(value, 4); ws.send(event) }
        setTimeout(() => { clearTimeout(timer); ws.close(); resolve() }, 500)
      }
    })
  })
}
await fill("Controlled through VNC")
const control = await desktop.viewer(box, { view: "browser", control: true, origin: "http://localhost:3020" })
await assert.rejects(browser("observe", { tabId }))
await keys(control.url, [0xff09, 0xff0d])
await desktop.call(box, "/continue", {})
assert.match((await see()).text, /Saved: Controlled through VNC/)
await fill("Read-only must not save")
const watch = await desktop.viewer(box, { view: "computer", control: false, origin: "http://localhost:3020" })
await keys(watch.url, [0xff09, 0xff0d])
const unchanged = await see()
assert.match(unchanged.text, /Saved: Controlled through VNC/)
assert.doesNotMatch(unchanged.text, /Saved: Read-only must not save/)
const program = z.object({ ok: z.literal(true), value: z.object({ saved: z.literal(true) }), metrics: z.object({ actions: z.number() }) }).parse(await desktop.call(box, "/computer/program", {
  sessionId: "vnc-proof", surface: "browser", tabId,
  code: `await tools.ui.fill({target:{name:"Title"},text:"Saved through a Workbot program"}); await tools.ui.click({target:{name:"Save"}}); await tools.ui.waitFor({target:{text:"Saved: Saved through a Workbot program",exact:false}}); return {saved:true};`,
}))
assert.ok(program.metrics.actions >= 2)
assert.match((await see()).text, /Saved: Saved through a Workbot program/)
const waiting = desktop.call(box, "/computer/program", {
  sessionId: "vnc-proof", surface: "browser", tabId,
  code: `await tools.ui.waitFor({target:{name:"A control that never appears"},timeoutMs:15000}); return {unexpected:true};`,
})
await new Promise(resolve => setTimeout(resolve, 500))
assert.deepEqual(await desktop.call(box, "/stop", {}), { ok: true, paused: true })
const stopped = z.object({ ok: z.literal(false), error: z.object({ code: z.literal("program_stopped") }) }).parse(await waiting)
assert.equal(stopped.error.code, "program_stopped")
await assert.rejects(browser("observe", { tabId }))
await desktop.call(box, "/continue", {})
assert.match((await see()).text, /Saved: Saved through a Workbot program/)
const nativeProgram = z.object({ ok: z.literal(true), value: z.object({ width: z.number().positive(), height: z.number().positive() }), images: z.array(z.object({ type: z.literal("image") })).min(1) }).parse(await desktop.call(box, "/computer/program", {
  sessionId: "vnc-proof", surface: "computer",
  code: `await tools.ui.open({appId:"desktop",mode:"control",purpose:"Verify the shared desktop"}); await tools.ui.observe({screenshot:true}); await tools.ui.act({action:{type:"key",key:"escape"}}); const view = await tools.ui.observe({screenshot:true}); return {width:view.width,height:view.height};`,
}))
assert.equal(nativeProgram.value.width, 1280)
assert.equal(nativeProgram.value.height, 800)
await remote(`kill $(cat ${fixture}/pid); rm -r ${fixture}`)
console.log(JSON.stringify({ signedBrowserStream: true, signedDesktopStream: true, oneUseTickets: true, sharedBrowserTool: true, manualKeyboardSave: true, serverReadOnlyEnforced: true, takeoverPausesAgent: true, boundedBrowserProgram: true, stopCancelsProgram: true, boundedNativeProgram: true }))
