import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { CoreHookModuleStateSource } from "../src/core/hooks/module-state.js"
import { mergeCoreHookRecords } from "../src/core/hooks/merge.js"
import type { CoreMiddlewarePoints, CorePostCommitPoints, CoreResolverPoints, CoreTxPoints } from "../src/core/hooks/points.js"
import { createCoreHookRegistry, type CoreHookLogger } from "../src/core/hooks/registry.js"
import { runWithAfterCommit } from "../src/core/hooks/mutation.js"
import { shouldRunCoreHook } from "../src/core/hooks/run.js"
import type { CoreTx } from "../src/core/hooks/types.js"

// The registry never touches the transaction; handlers in these tests do not either.
const tx: CoreTx = Object.create(null)
const organizationId = "org_test"

type LogLine = { level: "info" | "warn" | "error"; message: string; fields?: Readonly<Record<string, unknown>> }

function recordingLogger() {
  const lines: LogLine[] = []
  const logger: CoreHookLogger = {
    info: (message, fields) => lines.push({ level: "info", message, fields }),
    warn: (message, fields) => lines.push({ level: "warn", message, fields }),
    error: (message, fields) => lines.push({ level: "error", message, fields }),
  }
  return { lines, logger }
}

function stateSource(input: { effective: boolean; available: boolean }): CoreHookModuleStateSource {
  return { isEffective: async () => input.effective, isAvailable: () => input.available }
}

function removingInput(afterCommit: (callback: () => Promise<void>) => void = () => {}): CoreTxPoints["member.removing"] {
  return { tx, organizationId: "org_test", memberIds: ["om_one"], removedAt: new Date(0), afterCommit }
}

function removedInput(): CorePostCommitPoints["member.removed"] {
  return { organizationId: "org_test", memberId: "om_one", memberCount: 1, source: "removal" }
}

describe("ordering and registration", () => {
  test("runs by order band, then by id", async () => {
    const registry = createCoreHookRegistry()
    const calls: string[] = []
    const add = (id: string, order?: number) => registry.registerTx({
      point: "member.removing", id, registrant: "legacy", order,
      handler: async () => { calls.push(id) },
    })
    add("legacy/b", 400)
    add("legacy/z")
    add("legacy/a", 400)
    add("legacy/first", 300)
    await registry.runTx("member.removing", removingInput())
    assert.deepEqual(calls, ["legacy/first", "legacy/a", "legacy/b", "legacy/z"])
    assert.deepEqual(registry.describe(), { "member.removing": ["legacy/first", "legacy/a", "legacy/b", "legacy/z"] })
  })

  test("rejects duplicate ids across points", () => {
    const registry = createCoreHookRegistry()
    registry.registerTx({ point: "team.deleting", id: "legacy/x", registrant: "legacy", handler: async () => {} })
    assert.throws(
      () => registry.registerTx({ point: "member.removing", id: "legacy/x", registrant: "legacy", handler: async () => {} }),
      /core_hook_duplicate_id/,
    )
  })

  test("refuses registration after freeze and after the first dispatch", async () => {
    const frozen = createCoreHookRegistry()
    frozen.freeze()
    assert.throws(
      () => frozen.registerTx({ point: "team.deleting", id: "legacy/late", registrant: "legacy", handler: async () => {} }),
      /core_hooks_frozen/,
    )

    const dispatched = createCoreHookRegistry()
    await dispatched.runTx("team.deleting", { tx, organizationId, teamId: "tem_one", removedAt: new Date(0) })
    assert.equal(dispatched.isFrozen(), true)
    assert.throws(
      () => dispatched.registerTx({ point: "team.deleting", id: "legacy/late", registrant: "legacy", handler: async () => {} }),
      /core_hooks_frozen/,
    )
  })
})

describe("skip rule", () => {
  const cases = [
    // moduleId, security, alwaysRun, effective, available, orgScoped → runs
    { moduleId: undefined, security: false, alwaysRun: undefined, effective: false, available: false, org: true, runs: true },
    { moduleId: "teams", security: false, alwaysRun: undefined, effective: true, available: false, org: true, runs: true },
    { moduleId: "teams", security: false, alwaysRun: undefined, effective: false, available: true, org: true, runs: false },
    { moduleId: "teams", security: true, alwaysRun: undefined, effective: false, available: false, org: true, runs: true },
    { moduleId: "teams", security: false, alwaysRun: "cleanup", effective: false, available: false, org: true, runs: true },
    { moduleId: "teams", security: false, alwaysRun: "consistency", effective: false, available: false, org: false, runs: true },
    { moduleId: "teams", security: false, alwaysRun: undefined, effective: false, available: true, org: false, runs: true },
    { moduleId: "teams", security: false, alwaysRun: undefined, effective: true, available: false, org: false, runs: false },
  ] as const

  for (const row of cases) {
    test(`moduleId=${row.moduleId} security=${row.security} alwaysRun=${row.alwaysRun} effective=${row.effective} available=${row.available} org=${row.org} → ${row.runs}`, async () => {
      const runs = await shouldRunCoreHook(
        { moduleId: row.moduleId, security: row.security, alwaysRun: row.alwaysRun },
        row.org ? { kind: "org", organizationId } : { kind: "instance" },
        stateSource(row),
      )
      assert.equal(runs, row.runs)
    })
  }

  test("skipped hooks are logged, and the source sees the caller's transaction", async () => {
    const { lines, logger } = recordingLogger()
    const registry = createCoreHookRegistry({ logger })
    const seen: Array<CoreTx | undefined> = []
    registry.setModuleStateSource({
      isEffective: async (input) => { seen.push(input.tx); return false },
      isAvailable: () => true,
    })
    const calls: string[] = []
    registry.registerTx({ point: "member.removing", id: "teams/cleanup", registrant: "teams", moduleId: "teams", alwaysRun: "cleanup", handler: async () => { calls.push("cleanup") } })
    registry.registerTx({ point: "member.removing", id: "teams/feature", registrant: "teams", moduleId: "teams", handler: async () => { calls.push("feature") } })
    await registry.runTx("member.removing", removingInput())
    assert.deepEqual(calls, ["cleanup"])
    assert.deepEqual(seen, [tx])
    assert.deepEqual(lines.map((line) => [line.message, line.fields?.hook_id]), [["core_hook_skipped", "teams/feature"]])
  })

  test("org-less input on an org point falls back to instance availability", async () => {
    const registry = createCoreHookRegistry()
    registry.setModuleStateSource(stateSource({ effective: true, available: false }))
    const calls: string[] = []
    registry.registerTx({ point: "team.membershipChanged", id: "ai/feature", registrant: "aiGateway", moduleId: "aiGateway", handler: async () => { calls.push("ran") } })
    await registry.runTx("team.membershipChanged", { tx, organizationId: null, teamId: "tem_one" })
    assert.deepEqual(calls, [])
  })
})

describe("guards", () => {
  test("first rejection wins and stops the chain", async () => {
    const registry = createCoreHookRegistry()
    const calls: string[] = []
    registry.registerGuard({ point: "team.mutationGuard", id: "a", registrant: "legacy", order: 1, handler: async () => { calls.push("a"); return null } })
    registry.registerGuard({ point: "team.mutationGuard", id: "b", registrant: "legacy", order: 2, handler: async () => { calls.push("b"); return { code: "scim_managed_team", status: 409, message: "no" } } })
    registry.registerGuard({ point: "team.mutationGuard", id: "c", registrant: "legacy", order: 3, handler: async () => { calls.push("c"); return { code: "other", status: 403, message: "no" } } })
    const rejection = await registry.runGuards("team.mutationGuard", { tx, organizationId, teamId: "tem_one", operation: "delete" })
    assert.equal(rejection?.code, "scim_managed_team")
    assert.deepEqual(calls, ["a", "b"])
  })

  test("a thrown guard fails closed", async () => {
    const registry = createCoreHookRegistry()
    registry.registerGuard({ point: "team.mutationGuard", id: "boom", registrant: "legacy", handler: async () => { throw new Error("db down") } })
    await assert.rejects(registry.runGuards("team.mutationGuard", { tx, organizationId, teamId: "tem_one", operation: "delete" }), /db down/)
  })
})

describe("transactions and afterCommit", () => {
  test("queued callbacks run after the body, in order", async () => {
    const calls: string[] = []
    const registry = createCoreHookRegistry()
    registry.registerTx({ point: "member.removing", id: "a", registrant: "legacy", order: 1, handler: async ({ afterCommit }) => { calls.push("tx-a"); afterCommit(async () => { calls.push("post-a") }) } })
    registry.registerTx({ point: "member.removing", id: "b", registrant: "legacy", order: 2, handler: async ({ afterCommit }) => { calls.push("tx-b"); afterCommit(async () => { calls.push("post-b") }) } })
    const result = await runWithAfterCommit(async (afterCommit) => {
      await registry.runTx("member.removing", removingInput(afterCommit))
      calls.push("commit")
      return "done"
    })
    assert.equal(result, "done")
    assert.deepEqual(calls, ["tx-a", "tx-b", "commit", "post-a", "post-b"])
  })

  test("a rolled-back body drops queued callbacks", async () => {
    const calls: string[] = []
    const registry = createCoreHookRegistry()
    registry.registerTx({ point: "member.removing", id: "a", registrant: "legacy", handler: async ({ afterCommit }) => { afterCommit(async () => { calls.push("post") }) } })
    registry.registerTx({ point: "member.removing", id: "b", registrant: "legacy", handler: async () => { throw new Error("rollback") } })
    await assert.rejects(runWithAfterCommit(async (afterCommit) => {
      await registry.runTx("member.removing", removingInput(afterCommit))
    }), /rollback/)
    assert.deepEqual(calls, [])
  })
})

describe("participants", () => {
  test("wrap the body with the lowest order outermost", async () => {
    const registry = createCoreHookRegistry()
    const calls: string[] = []
    for (const [id, order] of [["inner", 2], ["outer", 1]] as const) {
      registry.registerParticipant({
        point: "membership.mutation.participant", id, registrant: "legacy", order,
        handler: async (_input, next) => {
          calls.push(`${id}:before`)
          const value = await next()
          calls.push(`${id}:after`)
          return value
        },
      })
    }
    const value = await registry.runParticipants("membership.mutation.participant", { tx, organizationId, memberIds: [] }, async () => {
      calls.push("body")
      return 42
    })
    assert.equal(value, 42)
    assert.deepEqual(calls, ["outer:before", "inner:before", "body", "inner:after", "outer:after"])
  })
})

describe("post-commit error semantics", () => {
  test("isolate logs and continues", async () => {
    const { lines, logger } = recordingLogger()
    const registry = createCoreHookRegistry({ logger })
    const calls: string[] = []
    registry.registerPostCommit({ point: "member.removed", id: "a", registrant: "legacy", order: 1, handler: async () => { throw new Error("stripe down") } })
    registry.registerPostCommit({ point: "member.removed", id: "b", registrant: "legacy", order: 2, handler: async () => { calls.push("b") } })
    await registry.runPostCommit("member.removed", removedInput())
    assert.deepEqual(calls, ["b"])
    assert.deepEqual(lines.map((line) => [line.level, line.message, line.fields?.hook_id]), [["warn", "core_hook_failure", "a"]])
  })

  test("propagate skips later non-security hooks, still runs security hooks, then rethrows", async () => {
    const registry = createCoreHookRegistry({ sleep: async () => {} })
    const calls: string[] = []
    registry.registerPostCommit({ point: "member.removed", id: "a", registrant: "legacy", order: 1, errorPolicy: "propagate", handler: async () => { throw new Error("stripe down") } })
    registry.registerPostCommit({ point: "member.removed", id: "b", registrant: "legacy", order: 2, handler: async () => { calls.push("b") } })
    registry.registerPostCommit({ point: "member.removed", id: "c", registrant: "legacy", order: 3, security: true, handler: async () => { calls.push("c") } })
    await assert.rejects(registry.runPostCommit("member.removed", removedInput()), /stripe down/)
    assert.deepEqual(calls, ["c"])
  })

  test("security hooks retry, then log an error and report without failing the request", async () => {
    const { lines, logger } = recordingLogger()
    const reported: unknown[] = []
    const sleeps: number[] = []
    const registry = createCoreHookRegistry({
      logger,
      reportError: (error) => reported.push(error),
      sleep: async (ms) => { sleeps.push(ms) },
    })
    let attempts = 0
    registry.registerPostCommit({ point: "member.removed", id: "revoke", registrant: "legacy", security: true, handler: async () => { attempts += 1; throw new Error("google down") } })
    await registry.runPostCommit("member.removed", removedInput())
    assert.equal(attempts, 4)
    assert.deepEqual(sleeps, [250, 1_000, 4_000])
    assert.equal(reported.length, 1)
    assert.deepEqual(lines.map((line) => [line.level, line.message, line.fields?.organization_id]), [["error", "core_hook_security_failure", "org_test"]])
  })

  test("a security hook that recovers on retry logs nothing", async () => {
    const { lines, logger } = recordingLogger()
    const registry = createCoreHookRegistry({ logger, sleep: async () => {} })
    let attempts = 0
    registry.registerPostCommit({ point: "member.removed", id: "revoke", registrant: "legacy", security: true, handler: async () => { attempts += 1; if (attempts < 2) throw new Error("flaky") } })
    await registry.runPostCommit("member.removed", removedInput())
    assert.equal(attempts, 2)
    assert.deepEqual(lines, [])
  })
})

describe("boot contributors", () => {
  test("collect in order, skip unavailable modules unless security, and close registration", () => {
    const { lines, logger } = recordingLogger()
    const registry = createCoreHookRegistry({ logger })
    registry.setModuleStateSource(stateSource({ effective: true, available: false }))
    registry.registerBootContributor({ point: "auth.rawMutationDenials", id: "legacy/b", registrant: "legacy", order: 2, contribute: () => [{ path: "/b", message: "b" }] })
    registry.registerBootContributor({ point: "auth.rawMutationDenials", id: "legacy/a", registrant: "legacy", order: 1, contribute: () => [{ path: "/a", message: "a" }] })
    registry.registerBootContributor({ point: "auth.rawMutationDenials", id: "teams/off", registrant: "teams", moduleId: "teams", contribute: () => [{ path: "/off", message: "off" }] })
    registry.registerBootContributor({ point: "auth.rawMutationDenials", id: "teams/denial", registrant: "teams", moduleId: "teams", security: true, contribute: () => [{ path: "/kept", message: "kept" }] })
    assert.deepEqual(registry.collectBoot("auth.rawMutationDenials").flat().map((denial) => denial.path), ["/a", "/b", "/kept"])
    assert.ok(lines.some((line) => line.message === "core_hook_skipped" && line.fields?.hook_id === "teams/off"))
    assert.throws(() => registry.registerBootContributor({ point: "auth.modelIds", id: "late", registrant: "legacy", contribute: () => ({}) }), /core_hooks_frozen/)
  })

  test("a throwing contributor fails the boot", () => {
    const registry = createCoreHookRegistry()
    registry.registerBootContributor({ point: "auth.modelIds", id: "broken", registrant: "legacy", contribute: () => { throw new Error("boom") } })
    assert.throws(() => registry.collectBoot("auth.modelIds"), /boom/)
  })

  test("merging keyed fragments refuses a key contributed twice", () => {
    assert.deepEqual(mergeCoreHookRecords("auth.modelIds", [{ a: 1 }, { b: 2 }]), { a: 1, b: 2 })
    assert.throws(() => mergeCoreHookRecords("auth.modelIds", [{ a: 1 }, { a: 2 }]), /core_hook_contribution_collision/)
  })
})

describe("middleware", () => {
  test("runs in order and propagates errors", async () => {
    const registry = createCoreHookRegistry()
    const calls: string[] = []
    registry.registerMiddleware({ point: "oauth.firstPartyClients", id: "b", registrant: "legacy", order: 2, handler: async () => { calls.push("b"); throw new Error("denied") } })
    registry.registerMiddleware({ point: "oauth.firstPartyClients", id: "a", registrant: "legacy", order: 1, handler: async ({ clientId }) => { calls.push(`a:${clientId}`) } })
    registry.registerMiddleware({ point: "oauth.firstPartyClients", id: "c", registrant: "legacy", order: 3, handler: async () => { calls.push("c") } })
    const adapter: CoreMiddlewarePoints["oauth.firstPartyClients"]["adapter"] = Object.create(null)
    await assert.rejects(registry.runMiddleware("oauth.firstPartyClients", { clientId: "client", adapter }), /denied/)
    assert.deepEqual(calls, ["a:client", "b"])
  })
})

describe("resolvers", () => {
  const lookup: CoreResolverPoints["auth.signInMethodResolver"]["input"] = { lookup: "emailDomain", email: "person@example.com" }
  const requirement = (slug: string) => ({ organizationId: "org_test", organizationSlug: slug, signInPath: `/sso/${slug}`, ssoProviderId: null, hasSso: true })

  test("falls back to the Core default with no provider", async () => {
    const registry = createCoreHookRegistry()
    assert.equal(await registry.resolve("auth.signInMethodResolver", lookup, async () => null), null)
  })

  test("the highest-order running provider wins; a disabled module's provider is skipped", async () => {
    const registry = createCoreHookRegistry()
    registry.setModuleStateSource(stateSource({ effective: true, available: false }))
    registry.registerResolver({ point: "auth.signInMethodResolver", id: "legacy/low", registrant: "legacy", order: 100, handler: async () => requirement("low") })
    registry.registerResolver({ point: "auth.signInMethodResolver", id: "sso/high", registrant: "sso", moduleId: "enterpriseAuth.sso", order: 900, handler: async () => requirement("high") })
    assert.equal((await registry.resolve("auth.signInMethodResolver", lookup, async () => null))?.organizationSlug, "low")
  })

  test("two providers at the same order fail at registration", () => {
    const registry = createCoreHookRegistry()
    registry.registerResolver({ point: "auth.signInMethodResolver", id: "a", registrant: "legacy", handler: async () => null })
    assert.throws(() => registry.registerResolver({ point: "auth.signInMethodResolver", id: "b", registrant: "legacy", handler: async () => null }), /core_hook_resolver_conflict/)
  })
})
