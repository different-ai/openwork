/** Opt-in real computer proof. One disposable conversation, commands + Files + look + wake, cleanup in finally. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { Computers } from "../src/computer.js"
import { createComputerProvider } from "../src/providers.js"
import type { ComputerFile, ComputerFiles } from "../src/types.js"

const kind = process.env.HEADLESS_COMPUTER
if (kind !== "daytona" && kind !== "freestyle") throw new Error("HEADLESS_COMPUTER must be daytona or freestyle")
const apiKey = kind === "daytona" ? process.env.DAYTONA_API_KEY : process.env.FREESTYLE_API_KEY
if (!apiKey) throw new Error(`Missing ${kind} API key`)
const provider = await createComputerProvider({ kind, apiKey, snapshot: process.env.HEADLESS_COMPUTER_SNAPSHOT, apiUrl: process.env.DAYTONA_API_URL, target: process.env.DAYTONA_TARGET })
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
  if (provider.blocks?.pause) await provider.blocks.pause(box, { timeoutMs: 30000 })
  else await provider.stop(box, { timeoutMs: 30000 })
  const resumed = await computers.bash(session, "cat /workspace/out/proof.txt", 30)
  assert.equal(resumed.isError, false, resumed.output)
  assert.match(resumed.output, /hello from shared computer/)
  console.log(`${kind}: command, Python tools, kept file, look and resume passed`)
} finally { await computers.delete(session) }
