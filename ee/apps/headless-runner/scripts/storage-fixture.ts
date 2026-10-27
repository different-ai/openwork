/** Shared by the storage tests: an in-memory files bucket, seeded conversations, and the previous runner's Store. */
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { BlobStore } from "../src/blobs.js"
import { Store } from "../src/store.js"
import type { Message } from "../src/types.js"

/** A files bucket in memory, with hooks to make it fail the ways a real one can. */
export function memoryBlobs(clock: () => number = Date.now) {
  const objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; at: number }>()
  const hooks: {
    afterPut?: (key: string) => void | Promise<void>
    failPut?: (key: string) => boolean
    failGet?: (key: string) => boolean
    corruptGet?: (key: string) => boolean
    failDelete?: boolean
  } = {}
  const store: BlobStore = {
    kind: "s3",
    async put(key, bytes) {
      if (hooks.failPut?.(key)) throw new Error("s3_put_503")
      objects.set(key, { bytes: new Uint8Array(bytes), at: clock() })
      await hooks.afterPut?.(key)
    },
    async get(key) {
      if (hooks.failGet?.(key)) throw new Error("s3_get_503")
      const found = objects.get(key)
      if (!found) return null
      if (hooks.corruptGet?.(key)) {
        const copy = new Uint8Array(found.bytes)
        copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 0xff
        return copy
      }
      return new Uint8Array(found.bytes)
    },
    async delete(key) {
      if (hooks.failDelete) throw new Error("s3_delete_503")
      objects.delete(key)
    },
    async list(prefix) {
      return [...objects.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, lastModified: value.at }))
    },
  }
  const keys = (prefix = "") => [...objects.keys()].filter((key) => key.startsWith(prefix)).sort()
  return { store, objects, hooks, keys }
}

/** A finished turn: the person's message, a tool call and its result, and the answer. */
export function finishedTurn(store: Store, sessionId: string, messageId: string, input: { output?: string; answer?: string; kind?: "task" | "report"; parent?: string } = {}) {
  store.admitTurn({ sessionId, messageId, prompt: `prompt for ${messageId}`, model: "test-model", kind: input.kind, parent: input.parent })
  store.startTranscript(sessionId, messageId)
  const call = { id: `${messageId}-call`, name: "lookup", input: { q: messageId } }
  store.appendMessage(sessionId, messageId, { role: "assistant", text: "", toolCalls: [call] })
  store.appendMessage(sessionId, messageId, { role: "tool", callId: call.id, name: call.name, output: input.output ?? `result of ${messageId}`, isError: false })
  store.appendMessage(sessionId, messageId, { role: "assistant", text: input.answer ?? `answer to ${messageId}`, toolCalls: [] })
  store.addUsage(sessionId, messageId, { inputTokens: 5, cachedInputTokens: 1, outputTokens: 2 })
  store.setTurnStatus(sessionId, messageId, "completed")
}

/** A conversation of `count` finished turns, each about `size` bytes, plus a task and its report early on. */
export function seedConversation(store: Store, id: string, count: number, size = 1_500) {
  store.putSession(id, { owner: "test-owner", ref: "main", tasks: true, title: "Long chat" })
  for (let index = 0; index < count; index += 1) {
    finishedTurn(store, id, `m${String(index).padStart(3, "0")}`, { output: `${index}:`.padEnd(size, "x") })
    if (index === 2) {
      finishedTurn(store, id, "m002.t1", { kind: "task", parent: "m002" })
      finishedTurn(store, id, "m002.t1.r", { kind: "report", parent: "m002.t1" })
    }
  }
  // One stopped before it started: its prompt is all it has.
  store.admitTurn({ sessionId: id, messageId: "m_stopped", prompt: "never started", model: null })
  store.setTurnStatus(id, "m_stopped", "aborted")
  for (let index = count; index < count + 3; index += 1) finishedTurn(store, id, `m${String(index).padStart(3, "0")}`)
  store.writeFile(id, "memory/about.md", "Prefers mornings ✓")
}

export const toolMessage = (output: string): Message => ({ role: "tool", callId: "c", name: "read_file", output, isError: false })

/**
 * Runs `script` (TypeScript, with `Store` and `nodeSqlite` imported from the previous runner's src/) in a child
 * process, with the database path as its argument; returns its stdout. Null when that version can't be read here
 * (no git history), so the test says so instead of failing.
 */
export function withBaseRunner(ref: string, project: string) {
  const work = join(project, "node_modules/.cache/storage-test", String(process.pid))
  try {
    const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { cwd: project, encoding: "utf8" }).trim().replace(/\/$/, "")
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: project, encoding: "utf8" }).trim()
    const commit = execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    mkdirSync(work, { recursive: true })
    const archive = execFileSync("git", ["archive", "--format=tar", `${commit}:${prefix}`, "src"], { cwd: root, maxBuffer: 256 * 1024 * 1024 })
    execFileSync("tar", ["-x", "-C", work], { input: archive })
  } catch {
    rmSync(work, { recursive: true, force: true })
    return null
  }
  const tsx = join(project, "node_modules/.bin/tsx")
  let count = 0
  return {
    run(script: string, dbPath: string): string {
      count += 1
      const file = join(work, `script-${count}.ts`)
      writeFileSync(file, `import { Store } from "./src/store.ts"\nimport { nodeSqlite } from "./src/node-sqlite.ts"\nconst dbPath = process.argv[2] ?? ""\n${script}\n`)
      return execFileSync(tsx, [file, dbPath], { cwd: project, encoding: "utf8" })
    },
    [Symbol.dispose]: () => rmSync(work, { recursive: true, force: true }),
  }
}
