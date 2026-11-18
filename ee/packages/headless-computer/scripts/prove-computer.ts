/** Opt-in real computer proof. One disposable conversation, commands + Files + look + wake, cleanup in finally. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { Computers, PAUSE_TIMEOUT_MS } from "../src/computer.js"
import { createComputerProvider, createGatewayProvider } from "../src/providers.js"
import type { ComputerFile, ComputerFiles } from "../src/types.js"

// SANDBOX_GATEWAY=differently proves the computer through the sandbox gateway instead of a direct provider.
const provider = process.env.SANDBOX_GATEWAY === "differently" ? await gatewayProvider() : await directProvider()

async function gatewayProvider() {
  const { SANDBOX_GATEWAY_URL: url, SANDBOX_GATEWAY_API_KEY: apiKey, SANDBOX_GATEWAY_TEMPLATE: template } = process.env
  if (!url || !apiKey || !template) throw new Error("SANDBOX_GATEWAY=differently needs SANDBOX_GATEWAY_URL, SANDBOX_GATEWAY_API_KEY and SANDBOX_GATEWAY_TEMPLATE")
  return createGatewayProvider({ kind: "differently", url, apiKey, template })
}

async function directProvider() {
  const kind = process.env.HEADLESS_COMPUTER
  if (kind !== "daytona" && kind !== "freestyle") throw new Error("HEADLESS_COMPUTER must be daytona or freestyle, or set SANDBOX_GATEWAY=differently")
  const apiKey = kind === "daytona" ? process.env.DAYTONA_API_KEY : process.env.FREESTYLE_API_KEY
  if (!apiKey) throw new Error(`Missing ${kind} API key`)
  return createComputerProvider({ kind, apiKey, snapshot: process.env.HEADLESS_COMPUTER_SNAPSHOT, apiUrl: process.env.DAYTONA_API_URL, target: process.env.DAYTONA_TARGET })
}
const kept = new Map<string, { file: ComputerFile; bytes: Uint8Array<ArrayBuffer> }>()
const files: ComputerFiles = {
  maxFileBytes: 1024 * 1024,
  list: () => [...kept.values()].map(item => item.file),
  read: async (_, id) => kept.get(id) ?? null,
  add: async (_, input) => {
    const file: ComputerFile = { id: randomUUID(), name: input.name, source: input.source, size: input.bytes.length, updatedAt: Date.now() }
    kept.set(file.id, { file, bytes: input.bytes }); return file
  },
  replace: async (_, id, input) => {
    const item = kept.get(id)
    if (!item) return null
    item.file = { ...item.file, size: input.bytes.length, updatedAt: Date.now() }; item.bytes = input.bytes; return item.file
  },
  putPreview: async () => true,
}
const computers = new Computers({ provider, idlePauseMs: 1000, keepDays: 1, scope: "computer-proof" }, { files, readFile: async file => ({ text: new TextDecoder().decode(file.bytes) }) })
const session = `proof-${randomUUID()}`
try {
  const result = await computers.bash(session, "printf 'hello from shared computer' > /workspace/out/proof.txt; python3 -c 'import pandas, openpyxl; print(17*23)'", 60)
  assert.equal(result.isError, false, result.output)
  assert.match(result.output, /391/)
  assert.equal(kept.size, 1)
  assert.equal(new TextDecoder().decode([...kept.values()][0].bytes), "hello from shared computer")
  const looked = await computers.look(session, ["out/proof.txt"])
  assert.equal(looked.isError, false)
  assert.match(looked.output, /hello from shared computer/)
  const box = await computers.vm(session)
  // Pools that can neither pause nor stop keep idle computers running, so there is no resume to prove.
  const idles = provider.describe().stopResume
  if (idles && provider.blocks?.pause) await provider.blocks.pause(box, { timeoutMs: PAUSE_TIMEOUT_MS })
  else if (idles) await provider.stop(box, { timeoutMs: PAUSE_TIMEOUT_MS })
  const resumed = await computers.bash(session, "cat /workspace/out/proof.txt", 30)
  assert.equal(resumed.isError, false, resumed.output)
  assert.match(resumed.output, /hello from shared computer/)
  console.log(`${process.env.SANDBOX_GATEWAY === "differently" ? "sandbox gateway" : process.env.HEADLESS_COMPUTER}: command, Python tools, kept file, look and ${idles ? "resume" : "a second command (these pools can't pause or stop)"} passed`)
} finally { await computers.delete(session) }
