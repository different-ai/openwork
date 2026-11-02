import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { afterEach, mock, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import ts from "typescript"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/feature_cache_invalidation_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-feature-cache-invalidation-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-feature-cache-invalidation-unit-test-key"
process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_REDIS_URL = ""
process.env.DEN_DEPLOYMENT = "self_hosted"
process.env.DEN_FEATURE_NATIVE_DICTATION = ""
const { db } = await import("../src/db.js")
const { cache } = await import("../src/cache.js")
const { getOrganizationFeatures, organizationFeatureEnabled, updateFeatureRollout, updateMemberFeatureOverrides, updateOrganizationFeatureOverrides } = await import("../src/features.js")

const organizationId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const memberId = createDenTypeId("member")
const fault = new Error("write outcome uncertain")
const rolloutBefore = [{ feature_key: "nativeDictation", enabled: true, killed: false }]
const rolloutAfter = [{ feature_key: "nativeDictation", enabled: true, killed: true }]
const overrideAfter = [{ feature_key: "nativeDictation", enabled: true }]

type Read = { fields: string[]; limit?: number; lock?: string }

function stubReads(results: Array<unknown[] | Error>, events: string[] = []) {
  const reads: Read[] = []
  mock.method(db, "select", (fields: Record<string, unknown>) => {
    const read: Read = { fields: Object.keys(fields) }
    reads.push(read)
    const rows = results.shift()
    assert.notEqual(rows, undefined, "unexpected database read")
    const result = () => {
      events.push(rows instanceof Error ? "read-failed" : "read")
      return rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)
    }
    const chain = {
      from: () => chain,
      leftJoin: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: (count: number) => {
        read.limit = count
        return chain
      },
      for: (lock: string) => {
        read.lock = lock
        return chain
      },
      then: (resolve: (value: unknown[] | undefined) => unknown, reject: (reason: unknown) => unknown) => result().then(resolve, reject),
    }
    return chain
  })
  return reads
}

function stubWrites(events: string[], writeError?: Error) {
  const inserted: Record<string, unknown>[] = []
  const updated: Record<string, unknown>[] = []
  /** Rows appended to feature_change (plain inserts, no upsert). */
  const history: Record<string, unknown>[] = []
  mock.method(db, "insert", () => ({
    values(value: Record<string, unknown> | Record<string, unknown>[]) {
      return {
        async onDuplicateKeyUpdate() {
          if (!Array.isArray(value)) inserted.push(value)
          events.push(writeError ? "write-failed" : "write")
          if (writeError) throw writeError
        },
        then(resolve: (value: undefined) => unknown, reject: (reason: unknown) => unknown) {
          history.push(...(Array.isArray(value) ? value : [value]))
          events.push("history")
          return Promise.resolve(undefined).then(resolve, reject)
        },
      }
    },
  }))
  mock.method(db, "delete", () => ({
    async where() {
      events.push("delete")
      if (writeError) throw writeError
    },
  }))
  mock.method(db, "update", () => ({
    set(value: Record<string, unknown>) {
      updated.push(value)
      return {
        async where() {
          events.push("metadata-write")
        },
      }
    },
  }))
  return { inserted, updated, history }
}

function stubTransaction(events: string[], commitError?: Error) {
  mock.method(db, "transaction", async (body: (database: typeof db) => Promise<unknown>) => {
    events.push("begin")
    try {
      const result = await body(db)
      events.push("commit")
      if (commitError) throw commitError
      return result
    } catch (error) {
      events.push("transaction-failed")
      throw error
    }
  })
}

function spyInvalidation(events: string[]) {
  return mock.method(cache.features, "invalidate", async () => {
    events.push("invalidate")
  })
}

afterEach(() => mock.restoreAll())

test("rollout writes invalidate once after the write and successful readback, preserving the result", async () => {
  const events: string[] = []
  const reads = stubReads([rolloutBefore, rolloutAfter], events)
  const { inserted, history } = stubWrites(events)
  stubTransaction(events)
  const invalidation = spyInvalidation(events)
  const result = await updateFeatureRollout({ key: "nativeDictation", killed: true, defaultEnabled: false, updatedByUserId: userId })
  assert.deepEqual(result, { nativeDictation: { enabled: true, killed: true } })
  assert.deepEqual(inserted, [{ feature_key: "nativeDictation", enabled: true, killed: true, updated_by_user_id: userId }])
  assert.deepEqual(history, [{ feature_key: "nativeDictation", scope: "everyone", action: "killed", organization_id: null, member_id: null, changed_by_user_id: userId }])
  assert.equal(reads.length, 2)
  assert.equal(invalidation.mock.callCount(), 1)
  assert.deepEqual(events, ["begin", "read", "write", "history", "commit", "read", "invalidate"])
})

for (const stage of ["write", "readback"]) {
  test(`rollout invalidation runs after an uncertain ${stage} failure and preserves the original error`, async () => {
    const events: string[] = []
    stubReads(stage === "write" ? [rolloutBefore] : [rolloutBefore, fault], events)
    stubWrites(events, stage === "write" ? fault : undefined)
    stubTransaction(events)
    const invalidation = spyInvalidation(events)
    await assert.rejects(updateFeatureRollout({ key: "nativeDictation", killed: true, defaultEnabled: false }), (error: unknown) => error === fault)
    assert.equal(invalidation.mock.callCount(), 1)
    assert.deepEqual(events, stage === "write"
      ? ["begin", "read", "write-failed", "transaction-failed", "invalidate"]
      : ["begin", "read", "write", "history", "commit", "read-failed", "invalidate"])
  })
}

test("organization override writes invalidate once after the transaction commits, preserving the result", async () => {
  const events: string[] = []
  const reads = stubReads([[{ metadata: {} }], [], overrideAfter], events)
  const { inserted, updated, history } = stubWrites(events)
  stubTransaction(events)
  const invalidation = spyInvalidation(events)
  const result = await updateOrganizationFeatureOverrides({ organizationId, changes: { nativeDictation: true }, source: "platform", setByUserId: userId })
  assert.deepEqual(result, { nativeDictation: true })
  assert.deepEqual(inserted, [{ organization_id: organizationId, feature_key: "nativeDictation", enabled: true, source: "platform", set_by_user_id: userId }])
  assert.deepEqual(history, [{ feature_key: "nativeDictation", scope: "organization", action: "on", organization_id: organizationId, member_id: null, changed_by_user_id: userId }])
  assert.deepEqual(updated, [{ metadata: { capabilities: { nativeDictation: true } } }])
  assert.equal(reads[0].lock, "update")
  assert.equal(invalidation.mock.callCount(), 1)
  assert.deepEqual(events, ["begin", "read", "read", "write", "history", "read", "metadata-write", "commit", "invalidate"])
})

test("clearing an organization override invalidates after the deletion commits", async () => {
  const events: string[] = []
  stubReads([[{ metadata: { capabilities: { nativeDictation: true } } }], overrideAfter, []], events)
  const { inserted, updated, history } = stubWrites(events)
  stubTransaction(events)
  const invalidation = spyInvalidation(events)
  assert.deepEqual(await updateOrganizationFeatureOverrides({ organizationId, changes: { nativeDictation: null }, source: "platform" }), {})
  assert.deepEqual(inserted, [])
  assert.deepEqual(history, [{ feature_key: "nativeDictation", scope: "organization", action: "reset", organization_id: organizationId, member_id: null, changed_by_user_id: null }])
  assert.deepEqual(updated, [{ metadata: {} }])
  assert.equal(invalidation.mock.callCount(), 1)
  assert.deepEqual(events, ["begin", "read", "read", "delete", "history", "read", "metadata-write", "commit", "invalidate"])
})

test("setting an override to the value it already has adds nothing to the history", async () => {
  const events: string[] = []
  stubReads([[{ metadata: {} }], overrideAfter, overrideAfter], events)
  const { history } = stubWrites(events)
  stubTransaction(events)
  spyInvalidation(events)
  await updateOrganizationFeatureOverrides({ organizationId, changes: { nativeDictation: true }, source: "platform", setByUserId: userId })
  assert.deepEqual(history, [])
  assert.deepEqual(events, ["begin", "read", "read", "write", "read", "metadata-write", "commit", "invalidate"])
})

for (const stage of ["write", "commit"]) {
  test(`organization override invalidation runs after an uncertain ${stage} failure and preserves the original error`, async () => {
    const events: string[] = []
    stubReads(stage === "write" ? [[{ metadata: {} }], []] : [[{ metadata: {} }], [], overrideAfter], events)
    stubWrites(events, stage === "write" ? fault : undefined)
    stubTransaction(events, stage === "commit" ? fault : undefined)
    const invalidation = spyInvalidation(events)
    await assert.rejects(updateOrganizationFeatureOverrides({ organizationId, changes: { nativeDictation: true }, source: "platform" }), (error: unknown) => error === fault)
    assert.equal(invalidation.mock.callCount(), 1)
    assert.deepEqual(events, stage === "write"
      ? ["begin", "read", "read", "write-failed", "transaction-failed", "invalidate"]
      : ["begin", "read", "read", "write", "history", "read", "metadata-write", "commit", "transaction-failed", "invalidate"])
  })
}

for (const writer of ["rollout", "override"]) {
  test(`${writer} writer does not settle before asynchronous invalidation finishes`, async () => {
    const events: string[] = []
    stubReads(writer === "rollout" ? [rolloutBefore, rolloutAfter] : [[{ metadata: {} }], [], overrideAfter], events)
    stubWrites(events)
    stubTransaction(events)
    let finishInvalidation = () => {}
    const pendingInvalidation = new Promise<void>((resolve) => { finishInvalidation = resolve })
    let invalidationStarted = () => {}
    const started = new Promise<void>((resolve) => { invalidationStarted = resolve })
    mock.method(cache.features, "invalidate", async () => {
      invalidationStarted()
      await pendingInvalidation
    })
    let settled = false
    const write = (writer === "rollout"
      ? updateFeatureRollout({ key: "nativeDictation", killed: true, defaultEnabled: false })
      : updateOrganizationFeatureOverrides({ organizationId, changes: { nativeDictation: true }, source: "platform" }))
      .then((result) => { settled = true; return result })
    await started
    await Promise.resolve()
    assert.equal(settled, false)
    finishInvalidation()
    await write
    assert.equal(settled, true)
  })
}

test("organization maps resolve cached rollout and organization overrides", async () => {
  const state = mock.method(cache.features, "state", async () => ({
    rollouts: { nativeDictation: { enabled: false, killed: false } },
    overrides: { nativeDictation: true },
  }))
  const read = mock.method(db, "select", () => { throw new Error("cached feature resolution read the database") })
  const features = await getOrganizationFeatures(organizationId)
  assert.equal(features.nativeDictation, true)
  assert.equal(read.mock.callCount(), 0)
  assert.equal(state.mock.callCount(), 1)
  assert.deepEqual(state.mock.calls[0].arguments, [organizationId, undefined])
})

test("cached retired child settings cannot split the consolidated rollouts", async () => {
  mock.method(cache.features, "state", async () => ({
    rollouts: {
      workbotProactive: { enabled: false, killed: false },
      browserUse: { enabled: true, killed: true },
      computerUse: { enabled: false, killed: false },
      browserLiveView: { enabled: true, killed: false },
    },
    overrides: {
      workbotProactive: true,
      workbotAgentHealthView: false,
      workbotAgentLibrary: false,
      browserUse: true,
      computerUse: true,
      computerUseBackground: false,
    },
    memberOverrides: { workbotAgentLibrary: false, browserLiveView: true },
  }))
  const features = await getOrganizationFeatures(organizationId, { userId })
  assert.equal(features.workbotProactive, true)
  assert.equal(features.browserUse, false, "the retained browser kill switch still wins")
  assert.equal(features.computerUse, true)
  for (const key of ["workbotAgentHealthView", "workbotAgentLibrary", "browserLiveView", "computerUseBackground"]) {
    assert.equal(Object.hasOwn(features, key), false, "old cached child settings must not reappear in the feature map")
  }
})

test("member overrides come from the feature cache with the organization state, not a database read per request", async () => {
  const state = mock.method(cache.features, "state", async () => ({
    rollouts: { nativeDictation: { enabled: false, killed: false } },
    overrides: {},
    memberOverrides: { nativeDictation: true },
  }))
  const read = mock.method(db, "select", () => { throw new Error("cached member feature resolution read the database") })
  assert.equal((await getOrganizationFeatures(organizationId, { userId })).nativeDictation, true)
  assert.equal(read.mock.callCount(), 0)
  assert.deepEqual(state.mock.calls[0].arguments, [organizationId, userId])
})

test("members without overrides never read member overrides", async () => {
  const reads = stubReads([rolloutAfter, [], [{ organization_id: organizationId, user_id: createDenTypeId("user") }]])
  assert.deepEqual((await cache.features.state(organizationId, userId)).memberOverrides, {})
  assert.deepEqual(reads.map((read) => read.fields), [["feature_key", "enabled", "killed"], ["feature_key", "enabled"], ["organization_id", "user_id"]])
  stubReads([rolloutAfter, []])
  assert.deepEqual((await cache.features.state(organizationId)).memberOverrides, {})
})

test("members with overrides read them fresh from their active membership", async () => {
  const listed = [{ organization_id: organizationId, user_id: userId }, { organization_id: organizationId, user_id: userId }]
  const reads = stubReads([rolloutAfter, [], listed, [{ feature_key: "nativeDictation", enabled: false }]])
  assert.deepEqual((await cache.features.state(organizationId, userId)).memberOverrides, { nativeDictation: false })
  assert.deepEqual(reads[3].fields, ["feature_key", "enabled"])
})

test("a replaced membership does not inherit the previous membership's overrides from a stale member list", async () => {
  // The list still names the user, but the live join finds no rows for the new, active membership.
  stubReads([rolloutAfter, [], [{ organization_id: organizationId, user_id: userId }], []])
  assert.deepEqual((await cache.features.state(organizationId, userId)).memberOverrides, {})
})

test("member override writes invalidate the feature cache after the write commits", async () => {
  const events: string[] = []
  stubReads([[{ userId }], []], events)
  const { inserted, history } = stubWrites(events)
  stubTransaction(events)
  const invalidation = spyInvalidation(events)
  assert.equal(await updateMemberFeatureOverrides({ organizationId, memberId, changes: { nativeDictation: true }, setByUserId: userId }), true)
  assert.deepEqual(inserted, [{ member_id: memberId, feature_key: "nativeDictation", enabled: true, set_by_user_id: userId }])
  assert.deepEqual(history, [{ feature_key: "nativeDictation", scope: "member", action: "on", organization_id: organizationId, member_id: memberId, changed_by_user_id: userId }])
  assert.equal(invalidation.mock.callCount(), 1)
  assert.deepEqual(events, ["begin", "read", "read", "write", "history", "commit", "invalidate"])
})

test("member override invalidation runs after an uncertain write failure and preserves the original error", async () => {
  const events: string[] = []
  stubReads([[{ userId }], []], events)
  stubWrites(events, fault)
  stubTransaction(events)
  const invalidation = spyInvalidation(events)
  await assert.rejects(updateMemberFeatureOverrides({ organizationId, memberId, changes: { nativeDictation: true }, setByUserId: userId }), (error: unknown) => error === fault)
  assert.equal(invalidation.mock.callCount(), 1)
  assert.deepEqual(events, ["begin", "read", "read", "write-failed", "transaction-failed", "invalidate"])
})

for (const locked of [false, true]) {
  test(`fresh ${locked ? "locked" : "unlocked"} transaction reads bypass cached rollouts and overrides`, async () => {
    const events: string[] = []
    const reads = stubReads([[{ feature_key: "nativeDictation", enabled: false, killed: false }], overrideAfter], events)
    stubTransaction(events)
    mock.method(cache.features, "rollouts", () => { throw new Error("transaction read touched Redis rollouts") })
    mock.method(cache.features, "overrides", () => { throw new Error("transaction read touched Redis overrides") })
    mock.method(cache.features, "state", () => { throw new Error("transaction read touched Redis feature state") })
    const result = await db.transaction(async (tx) => getOrganizationFeatures(organizationId, { database: tx, lock: locked ? "share" : undefined }))
    assert.equal(result.nativeDictation, true)
    assert.deepEqual(reads.map((read) => read.fields), [["feature_key", "enabled", "killed"], ["feature_key", "enabled"]])
    assert.equal(reads[0].lock, undefined)
    assert.equal(reads[1].lock, locked ? "share" : undefined)
    assert.deepEqual(events, ["begin", "read", "read", "commit"])
  })
}

test("a share lock alone bypasses Redis and organizationFeatureEnabled propagates fresh-read options", async () => {
  const reads = stubReads([rolloutAfter, overrideAfter])
  mock.method(cache.features, "rollouts", () => { throw new Error("locked read touched Redis rollouts") })
  mock.method(cache.features, "overrides", () => { throw new Error("locked read touched Redis overrides") })
  mock.method(cache.features, "state", () => { throw new Error("locked read touched Redis feature state") })
  assert.equal(await organizationFeatureEnabled(organizationId, "nativeDictation", { lock: "share" }), false)
  assert.equal(reads.length, 2)
  assert.equal(reads[1].lock, "share")
})

function callsWithin(node: ts.Node, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  function visit(child: ts.Node) {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === name) calls.push(child)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return calls
}

for (const wiring of [
  { file: "routes/admin/index.ts", method: "put", endpoint: "/v1/admin/features/:key", wrapper: "updateFeatureRollout" },
  { file: "routes/admin/index.ts", method: "put", endpoint: "/v1/admin/organizations/:organizationId/capabilities", wrapper: "updateOrganizationFeatureOverrides" },
  { file: "mcp/admin-tools.ts", method: "registerTool", endpoint: "den_set_feature_rollout", wrapper: "updateFeatureRollout" },
  { file: "mcp/admin-tools.ts", method: "registerTool", endpoint: "den_set_org_capability", wrapper: "updateOrganizationFeatureOverrides" },
]) {
  test(`${wiring.endpoint} is wired to the cache-invalidating ${wiring.wrapper} wrapper`, async () => {
    const source = ts.createSourceFile(wiring.file, await readFile(new URL(`../src/${wiring.file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true)
    const importsWrapper = source.statements.some((statement) => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.endsWith("/features.js")) return false
      const bindings = statement.importClause?.namedBindings
      return bindings && ts.isNamedImports(bindings) && bindings.elements.some((element) => element.name.text === wiring.wrapper && !element.propertyName)
    })
    assert.ok(importsWrapper, "wrapper must be imported from features.ts")
    const registrations: ts.CallExpression[] = []
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === wiring.method) {
        const endpoint = node.arguments[0]
        if (endpoint && ts.isStringLiteral(endpoint) && endpoint.text === wiring.endpoint) registrations.push(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    assert.equal(registrations.length, 1)
    assert.equal(callsWithin(registrations[0], wiring.wrapper).length, 1)
    assert.equal(callsWithin(source, "setFeatureRollout").length, 0)
    assert.equal(callsWithin(source, "setOrganizationFeatureOverrides").length, 0)
  })
}

test("the admin member capabilities route writes through the cache-invalidating wrapper", async () => {
  const source = ts.createSourceFile("member-features.ts", await readFile(new URL("../src/routes/admin/member-features.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true)
  assert.equal(callsWithin(source, "updateMemberFeatureOverrides").length, 1)
  assert.equal(callsWithin(source, "setMemberFeatureOverrides").length, 0)
})
