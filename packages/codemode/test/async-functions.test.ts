import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Schema } from "effect"
import { CodeMode, Tool, toolError } from "../src/index.js"

// Async functions return promises and run their bodies concurrently, interleaving with other
// code only at awaits, as in JavaScript.

type Trace = { starts: Array<number>; active: number; maxActive: number }

const makeTrace = (): Trace => ({ starts: [], active: 0, maxActive: 0 })

const tools = (trace: Trace) => {
  const gates = new Map<number, Deferred.Deferred<void>>()
  const gate = (id: number) => {
    let found = gates.get(id)
    if (found === undefined) {
      found = Deferred.makeUnsafe<void>()
      gates.set(id, found)
    }
    return found
  }
  const tracked = <A>(id: number, work: Effect.Effect<A>) =>
    Effect.gen(function* () {
      trace.starts.push(id)
      trace.active += 1
      trace.maxActive = Math.max(trace.maxActive, trace.active)
      const result = yield* work
      trace.active -= 1
      return result
    })
  return {
    host: {
      // Settles at once.
      echo: Tool.make({
        description: "Echo an id",
        input: Schema.Struct({ id: Schema.Number }),
        output: Schema.Number,
        run: ({ id }) => Effect.succeed(id),
      }),
      // Settles after `ms` milliseconds.
      sleepy: Tool.make({
        description: "Echo an id after a delay",
        input: Schema.Struct({ id: Schema.Number, ms: Schema.Number }),
        output: Schema.Number,
        run: ({ id, ms }) => tracked(id, Effect.as(Effect.sleep(ms), id)),
      }),
      // Settles once `open` releases the same id, so overlap is structural, not timed.
      gated: Tool.make({
        description: "Echo an id once its gate opens",
        input: Schema.Struct({ id: Schema.Number }),
        output: Schema.Number,
        run: ({ id }) => tracked(id, Effect.as(Deferred.await(gate(id)), id)),
      }),
      open: Tool.make({
        description: "Open a gate",
        input: Schema.Struct({ id: Schema.Number }),
        output: Schema.Number,
        run: ({ id }) => Effect.as(Deferred.succeed(gate(id), undefined), id),
      }),
      fail: Tool.make({
        description: "Always refuse",
        input: Schema.Struct({}),
        output: Schema.String,
        run: () => Effect.fail(toolError("Lookup refused")),
      }),
    },
  }
}

const run = (code: string, options: { trace?: Trace; timeoutMs?: number } = {}) =>
  Effect.runPromise(
    CodeMode.execute({
      tools: tools(options.trace ?? makeTrace()),
      code,
      limits: { timeoutMs: options.timeoutMs ?? 2_000 },
    }),
  )

const value = async (code: string, options: { trace?: Trace; timeoutMs?: number } = {}) => {
  const result = await run(code, options)
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

const error = async (code: string, options: { trace?: Trace; timeoutMs?: number } = {}) => {
  const result = await run(code, options)
  if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`)
  return result.error
}

describe("async functions run concurrently", () => {
  test("map with an async callback that awaits overlaps every call, like map over direct calls", async () => {
    const shapes = [
      `await Promise.all(ids.map((id) => tools.host.sleepy({ id, ms: 30 })))`,
      `await Promise.all(ids.map(async (id) => tools.host.sleepy({ id, ms: 30 })))`,
      `await Promise.all(ids.map(async (id) => { await tools.host.sleepy({ id, ms: 30 }) }))`,
    ]
    for (const shape of shapes) {
      const trace = makeTrace()
      await value(`const ids = [1, 2, 3, 4, 5, 6, 7, 8]; ${shape}; return null`, { trace })
      expect(trace.maxActive).toBe(8)
    }
  })

  test("helpers that await several reads run side by side", async () => {
    const trace = makeTrace()
    const result = await value(
      `
        async function pages(first) {
          const one = await tools.host.gated({ id: first })
          const two = await tools.host.gated({ id: first + 1 })
          return [one, two]
        }
        const all = [pages(10), pages(20), pages(30)]
        for (const id of [10, 20, 30, 11, 21, 31]) await tools.host.open({ id })
        return await Promise.all(all)
      `,
      { trace },
    )
    expect(result).toEqual([
      [10, 11],
      [20, 21],
      [30, 31],
    ])
    // Every helper's first read was live before any gate opened.
    expect(trace.starts.slice(0, 3)).toEqual([10, 20, 30])
    expect(trace.maxActive).toBe(3)
  })

  test("an async function returns a promise and adopts a returned tool call", async () => {
    expect(
      await value(`
        const load = async (id) => tools.host.echo({ id })
        const pending = load(4)
        return [pending instanceof Promise, await pending, await load(5)]
      `),
    ).toEqual([true, 4, 5])
  })
})

describe("each async call keeps its own scopes", () => {
  test("concurrent calls of one function never see each other's parameters or locals", async () => {
    expect(
      await value(`
        const tag = "outer"
        const load = async (id) => {
          const tag = "inner-" + id
          const first = await tools.host.gated({ id })
          let doubled
          {
            const tag = "block-" + id
            doubled = [tag, first * 2]
          }
          const second = await tools.host.echo({ id: first * 10 })
          return [id, tag, doubled, second]
        }
        const a = load(1)
        const b = load(2)
        await tools.host.open({ id: 2 })
        await b
        await tools.host.open({ id: 1 })
        return [tag, await a, await b]
      `),
    ).toEqual([
      "outer",
      [1, "inner-1", ["block-1", 2], 10],
      [2, "inner-2", ["block-2", 4], 20],
    ])
  })

  test("the caller's block scopes survive bodies that resume while it waits inside a loop", async () => {
    const result = await value(`
      const seen = []
      const work = async (id) => {
        for (let step = 0; step < 3; step += 1) {
          const got = await tools.host.echo({ id: id * 10 + step })
          seen.push(id + ":" + step + ":" + got)
        }
        return id
      }
      const pending = [work(1), work(2)]
      const mine = []
      for (let i = 0; i < 3; i += 1) {
        const local = "main-" + i
        await tools.host.echo({ id: i })
        mine.push(local + ":" + i)
      }
      return { done: await Promise.all(pending), seen: seen.sort(), mine }
    `)
    expect(result).toEqual({
      done: [1, 2],
      seen: ["1:0:10", "1:1:11", "1:2:12", "2:0:20", "2:1:21", "2:2:22"],
      mine: ["main-0:0", "main-1:1", "main-2:2"],
    })
  })

  test("closures created in concurrent calls capture their own call's bindings", async () => {
    expect(
      await value(`
        const make = async (id) => {
          let count = id * 100
          await tools.host.echo({ id })
          return () => { count += 1; return count }
        }
        const [first, second] = await Promise.all([make(1), make(2)])
        return [first(), second(), first(), second()]
      `),
    ).toEqual([101, 201, 102, 202])
  })
})

describe("code between awaits runs to completion", () => {
  test("an async call runs to its first await before its caller continues", async () => {
    expect(
      await value(`
        const log = []
        const work = async () => {
          for (let i = 0; i < 3000; i += 1) {}
          log.push("body before await")
          await tools.host.echo({ id: 1 })
          log.push("body after await")
        }
        const pending = work()
        log.push("caller after call")
        await pending
        return log
      `),
    ).toEqual(["body before await", "caller after call", "body after await"])
  })

  test("long stretches between awaits are never interleaved, so no update is lost", async () => {
    // Effect preempts a busy fiber every couple of thousand steps; without the turn, a body
    // preempted between reading and writing `total` would lose another body's increments.
    expect(
      await value(`
        let total = 0
        const work = async () => {
          await tools.host.echo({ id: 1 })
          for (let i = 0; i < 3000; i += 1) {
            const before = total
            total = before + 1
          }
        }
        await Promise.all([work(), work(), work()])
        return total
      `),
    ).toBe(9000)
  })

  test("sync prefixes run in call order and continuations resume at awaits", async () => {
    const log = (await value(`
      const log = []
      const step = async (name) => {
        log.push(name + "1")
        await tools.host.echo({ id: 1 })
        log.push(name + "2")
      }
      const pending = [step("a"), step("b")]
      log.push("caller")
      await Promise.all(pending)
      return log
    `)) as Array<string>
    expect(log.slice(0, 3)).toEqual(["a1", "b1", "caller"])
    expect(log.slice(3).sort()).toEqual(["a2", "b2"])
  })

  test("deep recursion before a first await still completes", async () => {
    expect(
      await value(`
        const depth = async (n) => (n === 0 ? 0 : 1 + (await depth(n - 1)))
        return await depth(250)
      `),
    ).toBe(250)
  })
})

describe("async call failures and leftovers", () => {
  test("a throw rejects the promise instead of throwing at the call site", async () => {
    expect(
      await value(`
        const fail = async () => { throw new Error("boom") }
        const pending = fail()
        try {
          await pending
          return "no"
        } catch (error) {
          return error.message
        }
      `),
    ).toBe("boom")
  })

  test("a never-awaited failing async call is an unhandled-rejection diagnostic", async () => {
    const diagnostic = await error(`
      const check = async () => { await tools.host.fail({}) }
      check()
      return "done"
    `)
    expect(diagnostic.kind).toBe("ToolFailure")
    expect(diagnostic.message).toContain("Unhandled rejection from an un-awaited promise")
    expect(diagnostic.message).toContain("Lookup refused")
  })

  test("work an un-awaited async call starts after the program returns still finishes", async () => {
    const trace = makeTrace()
    expect(
      await value(
        `
          const later = async () => {
            await tools.host.sleepy({ id: 1, ms: 10 })
            tools.host.sleepy({ id: 2, ms: 10 })
          }
          later()
          return "returned"
        `,
        { trace },
      ),
    ).toBe("returned")
    expect(trace.starts).toEqual([1, 2])
    expect(trace.active).toBe(0)
  })

  test("the timeout interrupts an async call stuck in a loop or on a call that never settles", async () => {
    const spinning = await error(
      `
        const spin = async () => { await tools.host.echo({ id: 1 }); while (true) {} }
        return await Promise.all([spin(), tools.host.echo({ id: 2 })])
      `,
      { timeoutMs: 150 },
    )
    expect(spinning.kind).toBe("TimeoutExceeded")
    const stuck = await error(
      `
        const wait = async () => tools.host.gated({ id: 1 })
        return await wait()
      `,
      { timeoutMs: 150 },
    )
    expect(stuck.kind).toBe("TimeoutExceeded")
  })
})

describe("callbacks whose result CodeMode uses await async callbacks", () => {
  test("filter, find, some, every, flatMap, reduce, sort, forEach and replace see resolved values", async () => {
    expect(
      await value(`
        const ids = [3, 1, 2]
        const big = async (id) => (await tools.host.echo({ id })) > 1
        const seen = []
        ids.forEach(async (id) => { seen.push(await tools.host.echo({ id })) })
        return {
          filter: ids.filter(big),
          find: ids.find(big),
          some: ids.some(big),
          every: ids.every(big),
          flatMap: ids.flatMap(async (id) => [id, await tools.host.echo({ id: id * 10 })]),
          reduce: ids.reduce(async (sum, id) => sum + (await tools.host.echo({ id })), 0),
          sort: ids.toSorted(async (a, b) => (await tools.host.echo({ id: a })) - b),
          seen,
          replace: "a-b".replace(/[ab]/g, async (letter) => letter + (await tools.host.echo({ id: 7 }))),
        }
      `),
    ).toEqual({
      filter: [3, 2],
      find: 3,
      some: true,
      every: false,
      flatMap: [3, 30, 1, 10, 2, 20],
      reduce: 6,
      sort: [1, 2, 3],
      seen: [3, 1, 2],
      replace: "a7-b7",
    })
  })
})
