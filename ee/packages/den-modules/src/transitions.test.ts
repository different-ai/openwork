import type { ModuleState } from "@openwork/license-contracts/resolver"
import { describe, expect, test } from "vitest"
import { createModuleRuntime } from "./runtime"
import { createFakeClock, createMemoryLogger, testInstanceConfig, testOrganizationModules, testOrgRow } from "./testing"
import { becameUsable, diffEffectiveModules, TransitionDispatcher, type ModuleStateChange, type ModuleTransition } from "./transitions"

const flush = () => new Promise((resolve) => setImmediate(resolve))

function setup() {
  const clock = createFakeClock()
  const logger = createMemoryLogger()
  const modules = createModuleRuntime({ deployment: "cloud", instance: testInstanceConfig(), clock: clock.now, logger, isProduction: true })
  const events: ModuleTransition[] = []
  modules.onModuleTransition((transition) => {
    events.push(transition)
  })
  return { modules, clock, logger, events }
}

describe("diffEffectiveModules / becameUsable", () => {
  test("reports state kind and reason changes only", () => {
    const { modules } = setup()
    const before = modules.resolveForRow(testOrgRow())
    const after = modules.resolveForRow(testOrgRow({ metadata: { capabilities: { workbot: true } }, modules: testOrganizationModules({ disabled: ["installLinks"] }) }))
    expect(diffEffectiveModules(before, before)).toEqual([])
    expect(diffEffectiveModules(before, after).map((change) => [change.moduleId, change.from.state, change.to.state])).toEqual([
      ["workbot", "off", "on"],
      ["installLinks", "on", "off"],
    ])
  })

  test("becameUsable is off → on | restricted", () => {
    const off: ModuleState = { state: "off", reason: "not_entitled" }
    expect(becameUsable(off, { state: "on" })).toBe(true)
    expect(becameUsable(off, { state: "restricted", until: "2026-11-01T00:00:00.000Z", operations: { other: "deny" } })).toBe(true)
    expect(becameUsable({ state: "on" }, off)).toBe(false)
    expect(becameUsable(off, { state: "off", reason: "requires", requires: "connect" })).toBe(false)
  })
})

describe("transition events", () => {
  test("no event on first sight; an observed change emits once", async () => {
    const { modules, events } = setup()
    modules.getEffectiveModules(testOrgRow({ id: "org_a" }))
    await flush()
    expect(events).toEqual([])
    modules.getEffectiveModules(testOrgRow({ id: "org_a", metadata: { capabilities: { auditLogs: true } } }))
    await flush()
    expect(events.map((event) => [event.moduleId, event.cause, event.to.state])).toEqual([
      ["auditLogs", "observed", "on"],
      ["auditLogs.export", "observed", "on"],
    ])
  })

  test("recordModulesWrite emits with its cause and drops the memo entry", async () => {
    const { modules, events } = setup()
    const before = testOrgRow({ id: "org_a" })
    const memoized = modules.getEffectiveModules(before)
    const after = testOrgRow({ id: "org_a", modules: testOrganizationModules({ disabled: ["connect"] }) })
    modules.recordModulesWrite({ before, after, cause: "org_toggle" })
    await flush()
    expect(events.find((event) => event.moduleId === "connect")).toMatchObject({ cause: "org_toggle", from: { state: "on" }, to: { state: "off", reason: "disabled_by_org" } })
    expect(events.some((event) => event.moduleId === "mcpApps")).toBe(true)
    expect(modules.getEffectiveModules(before)).not.toBe(memoized)
    await flush()
    expect(events.filter((event) => event.cause === "observed")).toEqual([])
  })

  test("dedupes the same (org, module, state) for a minute", async () => {
    const { modules, clock, events } = setup()
    const on = testOrgRow({ id: "org_a", metadata: { capabilities: { workbot: true } } })
    const off = testOrgRow({ id: "org_a" })
    modules.recordModulesWrite({ before: off, after: on, cause: "org_toggle" })
    modules.recordModulesWrite({ before: off, after: on, cause: "org_toggle" })
    clock.advance(61_000)
    modules.recordModulesWrite({ before: off, after: on, cause: "org_toggle" })
    await flush()
    expect(events.filter((event) => event.moduleId === "workbot")).toHaveLength(2)
  })

  test("a failing listener is isolated and logged", async () => {
    const logger = createMemoryLogger()
    const dispatcher = new TransitionDispatcher(logger)
    const received: string[] = []
    dispatcher.subscribe(() => {
      throw new Error("boom")
    })
    dispatcher.subscribe(async () => {
      throw new Error("async boom")
    })
    const unsubscribe = dispatcher.subscribe((transition) => {
      received.push(transition.moduleId)
    })
    const change: ModuleStateChange = { moduleId: "teams", from: { state: "off", reason: "disabled_by_org" }, to: { state: "on" } }
    dispatcher.emit("org_a", [change], "org_toggle", new Date())
    await flush()
    await flush()
    expect(received).toEqual(["teams"])
    expect(logger.named("den_modules_transition_listener_failed")).toHaveLength(2)
    unsubscribe()
    expect(dispatcher.listenerCount).toBe(2)
  })
})
