import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { AuditLogError, auditOperationBinding, isAuditKind, type AuditDatabase, type AuditEventInput, type AuditPolicy, type AuditTx } from "@openwork-ee/den-db/audit-log"

// Loading the audit catalog loads the legacy registrations, which pull in real
// modules that read env at import. These placeholders never reach a database.
const placeholders: Record<string, string> = {
  DEN_BASE_URL: "http://localhost:3005",
  DATABASE_URL: "mysql://root:password@127.0.0.1:3306/core_audit_test",
  DEN_DB_ENCRYPTION_KEY: "core-audit-test-db-encryption-key-not-a-secret-1234567890",
  BETTER_AUTH_SECRET: "core-audit-test-auth-secret-not-a-secret!!",
  OPENWORK_DEV_MODE: "1",
}
for (const [key, value] of Object.entries(placeholders)) {
  process.env[key] ??= value
}

const {
  ORGANIZATION_AUDIT_ACTIONS,
  ORGANIZATION_AUDIT_EVENT_TYPES,
  auditEventTypes,
  auditFreeText,
  createAuditRegistry,
  openAuditCapture,
  organizationRouteAuditContext,
  platformAdminAuditContext,
  recordAuditAfterCommit,
} = await import("../src/core/audit/index.js")
const { createAuditLogsSink, toAuditContext } = await import("../src/audit/sink.js")
const { orgAuditCoverage, supportedAuditEventTypes } = await import("../src/audit/coverage.js")

const tx: AuditTx = Object.create(null)
const organizationId = "org_01kz0000000000000000000000"
const userId = "usr_01kz0000000000000000000000"
const memberId = "om_01kz0000000000000000000000"
const roleId = "orl_01kz0000000000000000000000"

const policy: AuditPolicy = {
  organizationId, revision: 1, source: "cloud", enabled: true, categories: ["security", "change"],
  allowance: 6_000_000, excessMode: "delete_oldest", effectiveAt: new Date(0).toISOString(), captureStartedAt: null, attachmentWindowSeconds: 300,
}

function roleEvent(category: AuditEventInput["category"] = "security"): AuditEventInput {
  return {
    action: ORGANIZATION_AUDIT_ACTIONS.roleCreated, category, outcome: "succeeded",
    resources: [{ type: "organization_role", id: roleId, relationship: "target" }, { type: "organization", id: organizationId, relationship: "parent" }],
    changes: { before: null, after: { role: "reviewer" }, changedFields: ["role"] },
  }
}

const roleContext = organizationRouteAuditContext({ organizationId, userId, memberId, requestId: "req_test" }, "organization.role", roleId)

function fakeDatabase(transaction: (run: (tx: AuditTx) => Promise<unknown>) => Promise<unknown>): AuditDatabase {
  return Object.assign(Object.create(null), { transaction })
}

function sinkWith(options: { effective?: boolean; policy?: AuditPolicy | null; appended?: unknown[] }) {
  const registry = createAuditRegistry()
  registry.registerEventTypes(ORGANIZATION_AUDIT_EVENT_TYPES)
  registry.registerSink(createAuditLogsSink({
    eventTypeFor: registry.eventTypeFor,
    gate: { isEffective: async () => options.effective ?? true },
    readPolicy: async () => options.policy === undefined ? policy : options.policy,
    append: async (_tx, input) => {
      options.appended?.push(input)
      return null
    },
  }))
  return registry
}

describe("Core audit registry", () => {
  test("the default sink of a fresh registry records nothing", async () => {
    const registry = createAuditRegistry()
    assert.equal(await openAuditCapture(tx, roleContext, registry), null)
    let opened = false
    const database = fakeDatabase(async (run) => { opened = true; return run(tx) })
    assert.equal(await recordAuditAfterCommit(roleContext, roleEvent(), { database, registry }), "skipped")
    assert.equal(opened, true)
  })

  test("a second sink registration and duplicate kinds or actions are rejected", () => {
    const registry = createAuditRegistry()
    registry.registerSink(async () => null)
    assert.throws(() => registry.registerSink(async () => null), /audit_sink_already_registered/)
    registry.registerEventTypes(ORGANIZATION_AUDIT_EVENT_TYPES)
    assert.throws(() => registry.registerEventTypes([ORGANIZATION_AUDIT_EVENT_TYPES[0]]), /audit_event_kind_already_registered/)
    const fresh = createAuditRegistry()
    assert.throws(() => fresh.registerEventTypes([
      { kind: "organization.role", owner: "core", actions: ["organization.role.created"], categories: ["security"], resources: [] },
      { kind: "organization.sso", owner: "core", actions: ["organization.role.created"], categories: ["security"], resources: [] },
    ]), /audit_event_action_already_registered/)
  })

  test("the legacy registration installs the auditLogs sink and every organization event type", () => {
    const kinds = auditEventTypes().map((declaration) => declaration.kind)
    for (const declaration of ORGANIZATION_AUDIT_EVENT_TYPES) assert.ok(kinds.includes(declaration.kind), declaration.kind)
  })
})

describe("auditLogs sink", () => {
  test("returns null when auditLogs is not effective or the policy is off", async () => {
    assert.equal(await openAuditCapture(tx, roleContext, sinkWith({ effective: false })), null)
    assert.equal(await openAuditCapture(tx, roleContext, sinkWith({ policy: null })), null)
    assert.equal(await openAuditCapture(tx, roleContext, sinkWith({ policy: { ...policy, enabled: false } })), null)
  })

  test("appends with the registered kind and the legacy action string", async () => {
    const appended: unknown[] = []
    const capture = await openAuditCapture(tx, roleContext, sinkWith({ appended }))
    assert.ok(capture)
    await capture.record(roleEvent())
    assert.equal(appended.length, 1)
    assert.deepEqual(appended[0], {
      context: {
        organizationId, actor: { type: "user", id: userId, memberId }, principalKey: `user:${userId}:member:${memberId}:credential:session`,
        origin: "api", originTrust: "authenticated", requestId: "req_test", kind: "organization.role", scope: roleId,
      },
      policy,
      event: roleEvent(),
    })
  })

  test("skips categories the policy does not select", async () => {
    const appended: unknown[] = []
    const capture = await openAuditCapture(tx, organizationRouteAuditContext({ organizationId, userId, memberId }, "organization.scim", organizationId), sinkWith({ appended }))
    assert.ok(capture)
    const recorded = await capture.record({ action: ORGANIZATION_AUDIT_ACTIONS.scimReconciliationRun, category: "execution", outcome: "succeeded", resources: [{ type: "organization", id: organizationId, relationship: "target" }] })
    assert.equal(recorded, false)
    assert.equal(appended.length, 0)
  })

  test("rejects actions or categories that the kind does not declare", async () => {
    const capture = await openAuditCapture(tx, roleContext, sinkWith({}))
    assert.ok(capture)
    await assert.rejects(capture.record({ ...roleEvent(), action: ORGANIZATION_AUDIT_ACTIONS.ssoConnectionEnabled }), (error) => error instanceof AuditLogError && error.code === "audit_invalid_input")
    await assert.rejects(capture.record(roleEvent("change")), (error) => error instanceof AuditLogError && error.code === "audit_invalid_input")
  })

  test("rejects a kind without a declaration", async () => {
    const registry = createAuditRegistry()
    registry.registerSink(createAuditLogsSink({ eventTypeFor: registry.eventTypeFor, gate: { isEffective: async () => true }, readPolicy: async () => policy }))
    await assert.rejects(openAuditCapture(tx, roleContext, registry), (error) => error instanceof AuditLogError && error.code === "audit_invalid_input")
  })

  test("platform admin context has no member and the platform_admin origin", () => {
    const context = toAuditContext(platformAdminAuditContext({ organizationId, adminUserId: userId, requestId: null }))
    assert.equal(context.origin, "platform_admin")
    assert.deepEqual(context.actor, { type: "user", id: userId })
    assert.equal(context.principalKey, `user:${userId}:member:none:credential:session`)
    assert.equal(context.kind, "platform_admin.organization")
  })
})

describe("post-commit capture", () => {
  test("a capture failure is reported and never thrown", async () => {
    const database = fakeDatabase(async () => { throw new AuditLogError("audit_policy_changed") })
    assert.equal(await recordAuditAfterCommit(roleContext, roleEvent(), { database, registry: sinkWith({}) }), "failed")
  })

  test("a recorded event reports recorded", async () => {
    const appended: unknown[] = []
    const registry = createAuditRegistry()
    registry.registerEventTypes(ORGANIZATION_AUDIT_EVENT_TYPES)
    registry.registerSink(createAuditLogsSink({
      eventTypeFor: registry.eventTypeFor, gate: { isEffective: async () => true }, readPolicy: async () => policy,
      append: async (_tx, input) => { appended.push(input); return Object.create(null) },
    }))
    const database = fakeDatabase(async (run) => run(tx))
    assert.equal(await recordAuditAfterCommit(roleContext, roleEvent(), { database, registry }), "recorded")
    assert.equal(appended.length, 1)
  })
})

describe("operation kinds and coverage", () => {
  test("every organization kind is a den-db operation kind with request grouping", () => {
    for (const declaration of ORGANIZATION_AUDIT_EVENT_TYPES) {
      assert.ok(isAuditKind(declaration.kind), declaration.kind)
      const context = { ...toAuditContext(organizationRouteAuditContext({ organizationId, userId, memberId, requestId: "req_a" }, declaration.kind, organizationId)), correlationId: "6f1c2a8e-4b7d-4c1e-9a3f-2d5e8b7c6a10", workflowStep: "update", workflowStepScope: organizationId }
      // Request grouping ignores client correlation claims.
      assert.equal(auditOperationBinding(context), auditOperationBinding(context, false))
    }
    assert.equal(isAuditKind("organization.unknown"), false)
  })

  test("supported event types list every pre-W0-P09 action string", () => {
    const supported = supportedAuditEventTypes()
    for (const action of Object.values(ORGANIZATION_AUDIT_ACTIONS)) assert.ok(supported.includes(action), action)
  })

  test("no org route declares legacy-only coverage", () => {
    for (const [file, declaration] of Object.entries(orgAuditCoverage)) assert.notEqual(String(declaration.status), "legacy_only", file)
  })

  test("free text with a credential pattern is withheld instead of failing capture", () => {
    assert.equal(auditFreeText("Customer signed the DPA on the enterprise plan"), "Customer signed the DPA on the enterprise plan")
    assert.equal(auditFreeText("Basic plan customer"), "[withheld: matched a credential pattern]")
  })
})
