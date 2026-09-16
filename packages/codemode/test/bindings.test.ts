import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, Tool } from "../src/index.js"

const execute = (options: CodeMode.ExecuteOptions) => Effect.runPromise(CodeMode.execute(options))

describe("input bindings", () => {
  test("makes a binding visible and usable", async () => {
    const result = await execute({ code: "return input.x + 1", bindings: { input: { x: 1 } } })

    expect(result).toMatchObject({ ok: true, value: 2 })
  })

  test("rejects reassignment like a const binding", async () => {
    const result = await execute({ code: "input = 2", bindings: { input: 1 } })

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "ExecutionFailure", message: expect.stringContaining("Cannot assign to constant 'input'") },
    })
  })

  test("allows property mutation on the sandbox copy", async () => {
    const input = { x: 1 }
    const result = await execute({ code: "input.x += 1; return input.x", bindings: { input } })

    expect(result).toMatchObject({ ok: true, value: 2 })
    expect(input.x).toBe(1)
  })

  test("preserves nested sandbox mutation when readonly bindings are absent or false", async () => {
    for (const readonlyBindings of [undefined, false]) {
      const input = { runtime: { today: "2026-09-15" }, items: [{ count: 1 }] }
      const result = await execute({
        code: 'input.runtime.today = "changed"; input.items[0].count++; return input',
        bindings: { input },
        readonlyBindings,
      })

      expect(result).toMatchObject({ ok: true, value: { runtime: { today: "changed" }, items: [{ count: 2 }] } })
      expect(input).toEqual({ runtime: { today: "2026-09-15" }, items: [{ count: 1 }] })
    }
  })

  for (const mutation of [
    'input.runtime.today = "forged"',
    'const runtime = input.runtime; runtime.today = "forged"',
    'const { runtime } = input; runtime.today = "forged"',
    'const alias = { ...input }; alias.runtime.today = "forged"',
    'const key = "today"; input.runtime[key] = "forged"',
    'input.runtime = { today: "forged" }',
    'input = { runtime: { today: "forged" } }',
    'input.extra = "forged"',
    'input.items[0].count++',
    'input.items[0] = { count: 2 }',
    'input.items.push({ count: 2 })',
    'input.items.splice(0, 1)',
  ]) {
    test(`readonly bindings reject ${mutation} with a diagnostic`, async () => {
      const input = { runtime: { today: "2026-09-15" }, items: [{ count: 1 }] }
      const queries: string[] = []
      const tools = {
        read: Tool.make({
          description: "Read by date",
          input: Schema.Struct({ today: Schema.String }),
          run: ({ today }) => Effect.sync(() => { queries.push(today); return today }),
        }),
      }
      const options = { bindings: { input }, readonlyBindings: true, tools }
      const result = await Effect.runPromise(CodeMode.execute({
        ...options,
        code: `${mutation}; return await tools.read({ today: input.runtime.today })`,
      }))

      expect(result).toMatchObject({ ok: false, error: { kind: "ExecutionFailure" }, toolCalls: [] })
      expect(queries).toEqual([])
      const caught = await Effect.runPromise(CodeMode.execute({
        ...options,
        code: `try { ${mutation} } catch (error) {} return await tools.read({ today: input.runtime.today })`,
      }))
      expect(caught).toMatchObject({ ok: true, value: "2026-09-15" })
      expect(queries).toEqual(["2026-09-15"])
      expect(input).toEqual({ runtime: { today: "2026-09-15" }, items: [{ count: 1 }] })
      expect(Object.isFrozen(input)).toBe(false)
      expect(Object.isFrozen(input.runtime)).toBe(false)
      expect(Object.isFrozen(input.items)).toBe(false)
      expect(Object.isFrozen(input.items[0])).toBe(false)
    })
  }

  test("delete remains unsupported without changing binding data", async () => {
    for (const readonlyBindings of [undefined, true]) {
      const input = { runtime: { today: "2026-09-15" } }
      const result = await execute({
        code: "const runtime = input.runtime; delete runtime.today; return input",
        bindings: { input },
        readonlyBindings,
      })

      expect(result.ok).toBe(false)
      expect(input.runtime.today).toBe("2026-09-15")
    }
  })

  test("Object.assign preserves its copying semantics without mutating readonly bindings", async () => {
    const result = await execute({
      code: 'const copy = Object.assign(input.runtime, { today: "changed" }); copy.today += " again"; return { original: input.runtime.today, copy: copy.today }',
      bindings: { input: { runtime: { today: "2026-09-15" } } },
      readonlyBindings: true,
    })

    expect(result).toMatchObject({ ok: true, value: { original: "2026-09-15", copy: "changed again" } })
  })

  test("readonly bindings allow mutable spread copies and the existing date subset", async () => {
    const result = await execute({
      code: `const copy = { ...input.runtime };
        copy.today = "changed";
        return { original: input.runtime.today, copy: copy.today,
          instant: new Date(input.runtime.now).toISOString(),
          timestamp: Date.parse(input.runtime.now) }`,
      bindings: { input: { runtime: { today: "2026-09-15", now: "2026-09-15T12:00:00.000Z" } } },
      readonlyBindings: true,
    })

    expect(result).toMatchObject({ ok: true, value: {
      original: "2026-09-15", copy: "changed", instant: "2026-09-15T12:00:00.000Z",
      timestamp: Date.parse("2026-09-15T12:00:00.000Z"),
    } })
  })

  test("reusable runtimes freeze only each execution's binding copy", async () => {
    const input = { runtime: { today: "2026-09-15" } }
    const runtime = CodeMode.make({ bindings: { input }, readonlyBindings: true })

    expect(await Effect.runPromise(runtime.execute('input.runtime.today = "forged"'))).toMatchObject({ ok: false })
    input.runtime.today = "2026-09-16"
    expect(await Effect.runPromise(runtime.execute("return input.runtime.today"))).toMatchObject({ ok: true, value: "2026-09-16" })
  })

  test("rejects reserved binding names", async () => {
    const result = await execute({ code: "return null", bindings: { tools: 1 } })

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "InvalidDataValue", message: "Binding name 'tools' is reserved by CodeMode." },
    })
  })

  test("rejects non-identifier binding names", async () => {
    const result = await execute({ code: "return null", bindings: { "not-valid": 1 } })

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "InvalidDataValue",
        message: "Binding name 'not-valid' must be a valid JavaScript identifier.",
      },
    })
  })

  test("rejects invalid binding data", async () => {
    const cyclic: Record<string, CodeMode.DataValue> = {}
    cyclic.self = cyclic
    const result = await execute({ code: "return invalid", bindings: { invalid: cyclic } })

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "InvalidDataValue", message: "Binding 'invalid' contains a circular value." },
    })
  })

  test("works through reusable runtimes", async () => {
    const runtime = CodeMode.make({ bindings: { input: { x: 1 } } })
    const result = await Effect.runPromise(runtime.execute("return input.x + 1"))

    expect(result).toMatchObject({ ok: true, value: 2 })
  })
})
