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
