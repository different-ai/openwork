import { describe, expect, test } from "bun:test"

import { resolveCurrentToolLifecycle } from "@/lib/current-tool-lifecycle"

describe("resolveCurrentToolLifecycle", () => {
  test("only active current-turn tools remain running", () => {
    expect(resolveCurrentToolLifecycle("thinking", true, true)).toBe("running")
    expect(resolveCurrentToolLifecycle("responding", true, true)).toBe("running")
    expect(resolveCurrentToolLifecycle("compacting", true, true)).toBe("running")
  })

  test("unfinished current-turn tools expose waiting and interrupted outcomes", () => {
    expect(resolveCurrentToolLifecycle("waiting", true, true)).toBe("waiting")
    expect(resolveCurrentToolLifecycle("idle", true, true)).toBe("interrupted")
    expect(resolveCurrentToolLifecycle("error", true, true)).toBe("interrupted")
  })

  test("does not rewrite completed or historical tool calls", () => {
    expect(resolveCurrentToolLifecycle("idle", true, false)).toBeNull()
    expect(resolveCurrentToolLifecycle("responding", false, true)).toBeNull()
  })
})
