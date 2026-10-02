import { expect, test } from "bun:test"
import { Effect } from "effect"
import { CodeMode, Tool } from "../src/index.js"

test("host metadata survives discovery and unavailable tools fail before schema validation or dispatch", async () => {
  let calls = 0
  const tools = {
    provider: {
      known: Tool.make({
        description: "Known but unavailable",
        input: { type: "object" },
        metadata: { liveEligibility: { eligible: false, reason: "external_authority" } },
        unavailableReason: "live_capability_ineligible: external_authority",
        run: () => Effect.sync(() => { calls++; return 1 }),
      }),
    },
  }
  const discovery = await Effect.runPromise(CodeMode.execute({ tools, code: "return await tools.$codemode.search({})" }))
  expect(discovery.ok).toBe(true)
  if (discovery.ok) expect(discovery.value).toMatchObject({ items: [
    { path: "tools.provider.known", metadata: { liveEligibility: { eligible: false, reason: "external_authority" } } },
  ] })
  for (const path of ["tools.provider.known", "tools.provider['known']"]) {
    const result = await Effect.runPromise(CodeMode.execute({ tools, code: `return await ${path}()` }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ kind: "ToolUnavailable", message: "live_capability_ineligible: external_authority" })
    expect(result.toolCalls).toEqual([])
  }
  const unknown = await Effect.runPromise(CodeMode.execute({ tools, code: "return await tools.provider.unknown({})" }))
  expect(unknown.ok).toBe(false)
  if (!unknown.ok) expect(unknown.error.kind).toBe("UnknownTool")
  expect(calls).toBe(0)
})

test("unavailable tools cannot produce success through catch, finally or allSettled", async () => {
  let calls = 0
  const tools = { provider: { denied: Tool.make({
    description: "Unavailable dependency", input: { type: "object" },
    unavailableReason: "Dependency is unavailable",
    run: () => Effect.sync(() => { calls++; return 1 }),
  }) } }
  for (const code of [
    "try { await tools.provider.denied({}) } catch (error) { return 2 }",
    "try { await tools.provider.denied({}) } finally { return 2 }",
    "return await Promise.allSettled([tools.provider.denied({})])",
  ]) {
    const result = await Effect.runPromise(CodeMode.execute({ tools, code, failOnToolAvailabilityError: true }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("ToolUnavailable")
    expect(result.toolCalls).toEqual([])
  }
  expect(calls).toBe(0)
  // A denial is per execution, not sticky on a shared tool definition.
  const subsequent = await Effect.runPromise(CodeMode.execute({ tools, code: "return 2", failOnToolAvailabilityError: true }))
  expect(subsequent.ok).toBe(true)
})

test("caught unknown tool calls cannot hide missing workflow dependencies", async () => {
  for (const code of [
    "try { await tools.missing.read({}) } catch (error) { return [] }",
    "return await Promise.allSettled([tools.missing.read({})])",
  ]) {
    const result = await Effect.runPromise(CodeMode.execute({ tools: {}, code, failOnToolAvailabilityError: true }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("UnknownTool")
    expect(result.toolCalls).toEqual([])
  }
})

test("default and explicit non-strict executions recover availability errors and report completed fallback calls", async () => {
  let deniedCalls = 0
  let writes = 0
  const tools = { provider: {
    denied: Tool.make({ description: "Unavailable", input: { type: "object" }, unavailableReason: "Unavailable",
      run: () => Effect.sync(() => { deniedCalls++; return 0 }),
    }),
    write: Tool.make({ description: "Authorized fallback", input: { type: "object" },
      run: () => Effect.sync(() => { writes++; return 2 }),
    }),
  } }
  for (const failOnToolAvailabilityError of [undefined, false]) {
    for (const path of ["tools.provider.denied", "tools.provider.unknown"]) {
      for (const code of [
        `try { await ${path}({}) } catch (error) { return await tools.provider.write({}) }`,
        `try { await ${path}({}) } finally { return await tools.provider.write({}) }`,
        `await Promise.allSettled([${path}({})]); return await tools.provider.write({})`,
      ]) {
        const result = await Effect.runPromise(CodeMode.execute({ tools, code, failOnToolAvailabilityError }))
        expect(result).toMatchObject({ ok: true, value: 2, toolCalls: [{ name: "provider.write" }] })
      }
    }
  }
  expect(deniedCalls).toBe(0)
  expect(writes).toBe(12)
})
