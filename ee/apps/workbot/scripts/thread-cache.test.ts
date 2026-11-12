import assert from "node:assert/strict"
import { test } from "node:test"
import { clearThreadSnapshots, loadThreadSnapshot, saveThreadSnapshot } from "../../../packages/workbot-ui/src/thread-cache.js"

const store = new Map<string, string>()
const storage = {
  get length() { return store.size },
  key: (index: number) => [...store.keys()][index] ?? null,
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value) },
  removeItem: (key: string) => { store.delete(key) },
}
Object.defineProperty(globalThis, "window", { value: { localStorage: storage }, configurable: true })

const sam = { principalId: "user_sam", organizationId: "org_example" }
const alex = { principalId: "user_alex", organizationId: "org_example" }
const turns = Array.from({ length: 12 }, (_, index) => ({ id: `m${index}` }))

test("keeps the newest page of a quiet conversation, per person and chat", () => {
  store.clear()
  saveThreadSnapshot(sam, null, { available: true, status: "idle", turns, hasEarlier: false })
  const kept = loadThreadSnapshot(sam, null)
  assert.ok(typeof kept === "object" && kept !== null && "turns" in kept && Array.isArray(kept.turns) && "hasEarlier" in kept)
  assert.deepEqual(kept.turns.map((turn: { id: string }) => turn.id), ["m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11"])
  assert.equal(kept.hasEarlier, true)
  assert.equal(loadThreadSnapshot(alex, null), undefined)
  assert.equal(loadThreadSnapshot(sam, "sidechat000000001"), undefined)
  assert.equal(loadThreadSnapshot(undefined, null), undefined)
})

test("never keeps a reply in progress, and forgets everything on clear", () => {
  store.clear()
  saveThreadSnapshot(sam, null, { available: true, status: "busy", turns })
  assert.equal(loadThreadSnapshot(sam, null), undefined)
  saveThreadSnapshot(sam, null, { available: true, status: "idle", turns })
  saveThreadSnapshot(alex, "sidechat000000001", { available: true, status: "idle", turns })
  store.set("workbot.welcomed", "1")
  clearThreadSnapshots()
  assert.deepEqual([...store.keys()], ["workbot.welcomed"])
})

test("a kept page older than a week is dropped", () => {
  store.clear()
  saveThreadSnapshot(sam, null, { available: true, status: "idle", turns })
  const [key] = [...store.keys()]
  assert.ok(key)
  const value: { savedAt: number } = JSON.parse(store.get(key) ?? "{}")
  store.set(key, JSON.stringify({ ...value, savedAt: Date.now() - 8 * 86_400_000 }))
  assert.equal(loadThreadSnapshot(sam, null), undefined)
  assert.equal(store.size, 0)
})
