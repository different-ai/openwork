import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { test } from "node:test"
import ts from "typescript"
import { providerAuditRegistry, providerAuditStep } from "../src/audit/provider.js"
import { diffProviderSnapshots, type ProviderAuditSnapshot } from "../src/audit/provider-serializers.js"
import { auditEventTypesResponseSchema, type AuditEventTypesResponse } from "@openwork/types/den/audit"
import { auditCaptureCoverage, auditExclusions, auditReadCoverage, supportedAuditEventTypes, auditReadCoveredRoutes, auditRolloutStatus, orgAuditCoverage, otherAuditSurfaces, pilotPolicyCoverage, providerBackgroundSteps, providerCoverage, providerCoveredResources, providerCoveredRoutes, providerUncoveredRoutes } from "../src/audit/coverage.js"

function source(relative: string) {
  return ts.createSourceFile(relative, readFileSync(new URL(relative, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}
function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [node]
  node.forEachChild((child) => { result.push(...descendants(child)) })
  return result
}
function calls(node: ts.Node, name: string) {
  return descendants(node).filter(ts.isCallExpression).filter((call) => ts.isIdentifier(call.expression) && call.expression.text === name)
}
function property(node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  return node.properties.filter(ts.isPropertyAssignment).find((item) => (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name)?.initializer
}
function stringProperty(node: ts.ObjectLiteralExpression, name: string) {
  const value = property(node, name)
  return value && ts.isStringLiteral(value) ? value.text : undefined
}
function paths(call: ts.CallExpression) {
  const path = call.arguments[0]
  if (path && ts.isStringLiteral(path)) return [path.text]
  if (path && ts.isIdentifier(path)) {
    for (let parent: ts.Node | undefined = call.parent; parent; parent = parent.parent) {
      if (ts.isForOfStatement(parent) && ts.isArrayLiteralExpression(parent.expression)) {
        assert.ok(ts.isVariableDeclarationList(parent.initializer))
        assert.equal(parent.initializer.declarations[0].name.getText(), path.text)
        return parent.expression.elements.map((element) => { assert.ok(ts.isStringLiteral(element)); return element.text })
      }
    }
  }
  throw new Error("Undeclared dynamic route; extend coverage extraction explicitly")
}
function routes(file: ts.SourceFile) {
  return descendants(file).filter(ts.isCallExpression).flatMap((call) => {
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.expression.getText(file) !== "app" || !["get", "post", "patch", "delete", "put"].includes(call.expression.name.text)) return []
    return paths(call).map((path) => ({ method: call.expression.getText(file).split(".")[1].toUpperCase(), path, call }))
  })
}
function checkProviderRoutes(actual = routes(source("../src/routes/org/inference-providers.ts")), expected = providerCoveredRoutes) {
  for (const covered of expected) {
    const route = actual.find(({ method, path }) => method === covered.method && path === covered.path)
    assert.ok(route, `Missing covered route ${covered.method} ${covered.path}`)
    assert.ok(route.call.arguments.some((arg) => ts.isIdentifier(arg) && arg.text === "managementWrite"), `Capture middleware missing: ${covered.path}`)
    assert.ok(calls(route.call, "providerAuditMutation").length || calls(route.call, "providerTransaction").length, `Atomic emitter missing: ${covered.path}`)
    assert.equal(providerAuditStep(route.method, route.path), covered.step)
  }
}

test("every top-level organization module/directory requires an explicit coverage declaration", () => {
  const entries = readdirSync(new URL("../src/routes/org/", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.name.endsWith(".ts"))
    .map((entry) => entry.name + (entry.isDirectory() ? "/" : "")).sort()
  assert.deepEqual(entries, Object.keys(orgAuditCoverage).sort())
  assert.deepEqual(Object.entries(orgAuditCoverage).filter(([, entry]) => entry.status === "implemented_scoped").map(([name]) => name).sort(), ["audit.ts", "inference-providers.ts"])
  const legacyModules = entries.filter((name) => name.endsWith(".ts") && descendants(source(`../src/routes/org/${name}`)).some((node) => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.endsWith("/audit-events.js")))
  assert.deepEqual(Object.entries(orgAuditCoverage).filter(([, entry]) => entry.status === "legacy_only").map(([name]) => name).sort(), legacyModules)
})

test("legacy-only declarations match actual semantic action references without claiming operation capture", () => {
  const definitions = descendants(source("../src/audit-events.ts")).filter(ts.isVariableDeclaration).find((node) => node.name.getText() === "ORGANIZATION_AUDIT_ACTIONS")?.initializer
  assert.ok(definitions && ts.isObjectLiteralExpression(definitions))
  for (const [module, coverage] of Object.entries(orgAuditCoverage)) {
    if (coverage.status !== "legacy_only") continue
    const actions: Array<string | undefined> = descendants(source(`../src/routes/org/${module}`)).filter(ts.isPropertyAccessExpression)
      .filter((node) => ts.isIdentifier(node.expression) && node.expression.text === "ORGANIZATION_AUDIT_ACTIONS")
      .map((node) => stringProperty(definitions, node.name.text))
    assert.deepEqual([...new Set(actions)].sort(), [...coverage.actions].sort(), module)
    assert.deepEqual(coverage.operationKinds, [])
    assert.ok(coverage.limitations.includes("NOT every"))
  }
})

test("provider route registry, declared steps and actual atomic route references stay synchronized", () => {
  assert.deepEqual(Object.fromEntries(providerCoveredRoutes.map((route) => [`${route.method} ${route.path}`, route.step])), providerAuditRegistry.steps)
  assert.deepEqual(providerBackgroundSteps, providerAuditRegistry.backgroundSteps)
  assert.deepEqual(providerCoverage.categories, providerAuditRegistry.categories)
  const actual = routes(source("../src/routes/org/inference-providers.ts"))
  checkProviderRoutes(actual)
  const uncovered = actual.filter(({ method, path }) => method !== "GET" && !providerCoveredRoutes.some((entry) => entry.method === method && entry.path === path)).map(({ method, path }) => `${method} ${path}`).sort()
  assert.deepEqual(uncovered, [...providerUncoveredRoutes].sort())
  for (const route of providerCoveredRoutes) {
    assert.throws(() => checkProviderRoutes(actual.filter((item) => item.method !== route.method || item.path !== route.path)), /Missing covered route/)
  }
  const routeSource = source("../src/routes/org/inference-providers.ts")
  for (const reference of ["providerAuditStep", "loadProviderAudit", "providerRequestAuditContext", "recordProviderAttempt", "providerAuditMutation"]) assert.ok(calls(routeSource, reference).length, reference)
  const matrix = source("../src/llm/gateway-matrix.ts")
  for (const reference of ["loadProviderAudit", "providerSystemAuditContext", "providerAuditMutation", "recordProviderAttempt"]) assert.ok(calls(matrix, reference).length, reference)
  assert.ok(descendants(matrix).some((node) => ts.isStringLiteral(node) && node.text === "catalog.refresh"))
})

test("provider snapshot resource/action declarations match emitters and all actual diff actions", () => {
  const actualResources = descendants(source("../src/audit/provider.ts")).filter(ts.isObjectLiteralExpression).flatMap((node) => {
    const type = stringProperty(node, "type")
    const action = stringProperty(node, "action")
    return type && action ? [{ type, action }] : []
  })
  assert.deepEqual(actualResources.sort((a, b) => a.type.localeCompare(b.type)), [...providerCoveredResources].sort((a, b) => a.type.localeCompare(b.type)))
  const emitted = new Set<string>()
  for (const resource of providerCoveredResources) {
    const before: ProviderAuditSnapshot = new Map([[resource.type, { ...resource, id: "synthetic-resource", related: [], snapshot: { name: "Before" } }]])
    const after: ProviderAuditSnapshot = new Map([[resource.type, { ...resource, id: "synthetic-resource", related: [], snapshot: { name: "After" } }]])
    for (const [left, right] of [[new Map(), after], [before, after], [before, new Map()]] satisfies Array<[ProviderAuditSnapshot, ProviderAuditSnapshot]>) {
      for (const event of diffProviderSnapshots("synthetic-provider", left, right)) {
        assert.ok(providerCoverage.actions.includes(event.action), `Undeclared covered action ${event.action}`)
        emitted.add(event.action)
      }
    }
  }
  assert.deepEqual([...emitted].sort(), providerCoverage.actions.filter((action) => !action.startsWith("provider.configuration.")).sort())
  const provider = source("../src/audit/provider.ts")
  const attempts = descendants(provider).filter(ts.isPropertyAssignment).find((node) => node.name.getText() === "action" && ts.isTemplateExpression(node.initializer))
  assert.ok(attempts && ts.isTemplateExpression(attempts.initializer))
  assert.equal(attempts.initializer.head.text, "provider.configuration.")
  assert.equal(attempts.initializer.templateSpans[0].expression.getText(), "capture.step")
  const outcomes = descendants(attempts.initializer.templateSpans[1].expression).filter(ts.isStringLiteral).map((node) => node.text)
  assert.deepEqual(outcomes.sort(), ["attempted", "committed", "succeeded"])
})

test("each audit-read route calls serveAudit with the inventoried action and append references", () => {
  const file = source("../src/routes/org/audit.ts")
  const actual = routes(file)
  assert.equal(actual.length, auditReadCoveredRoutes.length + 1)
  const settings = actual.find(({ method, path }) => method === "PATCH" && path === "/v1/audit/settings")
  assert.ok(settings)
  assert.equal(calls(settings.call, "setAuditCaptureState").length, 1)
  assert.equal(calls(settings.call, "ensureOrganizationAdmin").length, 1)
  assert.equal(calls(settings.call, "readAuditEntitlement").length, 1)
  const writer = source("../../../packages/den-db/src/audit-log.ts")
  for (const action of auditCaptureCoverage.actions) assert.ok(descendants(writer).some((node) => ts.isStringLiteral(node) && node.text === action))
  for (const expected of auditReadCoveredRoutes) {
    const found = actual.find(({ method, path }) => method === expected.method && path === expected.path)
    assert.ok(found, expected.path)
    const serve = calls(found.call, "serveAudit")
    assert.equal(serve.length, 1)
    assert.ok(ts.isStringLiteral(serve[0].arguments[1]))
    assert.equal(serve[0].arguments[1].text, expected.action)
    for (const suffix of ["requested", "served"]) assert.ok(orgAuditCoverage["audit.ts"].actions.includes(`audit.${expected.action}.${suffix}`))
  }
  assert.equal(calls(file, "appendAuditEvent").length, 2)
  const templates = descendants(file).filter(ts.isTemplateExpression).filter((node) => node.head.text === "audit.")
  for (const suffix of [".requested", ".served"]) assert.ok(templates.some((node) => node.templateSpans[0].expression.getText() === "action" && node.templateSpans[0].literal.text === suffix))
  const pilot = source("../src/audit/pilot-policy.ts")
  const events = calls(pilot, "appendAuditEvent")
  assert.equal(events.length, 1)
  assert.ok(ts.isObjectLiteralExpression(events[0].arguments[1]))
  const event = property(events[0].arguments[1], "event")
  assert.ok(event && ts.isObjectLiteralExpression(event))
  assert.deepEqual(pilotPolicyCoverage.actions, [stringProperty(event, "action")])
  assert.deepEqual(pilotPolicyCoverage.categories, [stringProperty(event, "category")])
})

test("supported event catalog is the full bounded executable inventory, including hidden children and its own access events", () => {
  const expected = [...new Set([...providerCoverage.actions, ...auditReadCoverage.actions, ...pilotPolicyCoverage.actions, ...auditCaptureCoverage.actions])].sort()
  const response: AuditEventTypesResponse = auditEventTypesResponseSchema.parse({ eventTypes: supportedAuditEventTypes() })
  assert.deepEqual(response, { eventTypes: expected })
  assert.equal(response.eventTypes.length, new Set(response.eventTypes).size)
  for (const action of ["provider.credential.created", "provider.credential.updated", "provider.configuration.catalog.refresh.attempted", "provider.configuration.catalog.refresh.committed", "audit.policy.enabled", "audit.event_types.requested", "audit.event_types.served"]) assert.ok(response.eventTypes.includes(action), action)
  for (const entry of Object.values(orgAuditCoverage).filter((entry) => entry.status === "legacy_only")) {
    for (const action of entry.actions) assert.equal(response.eventTypes.includes(action), false, action)
  }
  response.eventTypes.pop()
  assert.deepEqual(supportedAuditEventTypes(), expected)
  assert.equal(auditEventTypesResponseSchema.safeParse({ eventTypes: expected, nextCursor: null }).success, false)
  assert.equal(auditEventTypesResponseSchema.safeParse({ eventTypes: [1] }).success, false)
})

test("outside-den-api, MCP/jobs and explicit health/static exclusions do not imply blanket coverage", () => {
  for (const surface of otherAuditSurfaces) assert.ok(existsSync(new URL(`../../../../${surface.location}`, import.meta.url)), surface.location)
  for (const surface of otherAuditSurfaces.filter(({ location }) => !location.startsWith("ee/apps/den-api/"))) assert.equal(surface.coverage.status, "uncovered")
  assert.ok(otherAuditSurfaces.some(({ surface, coverage }) => surface === "mcp" && coverage.status === "uncovered"))
  assert.ok(otherAuditSurfaces.some(({ surface, coverage }) => surface === "job" && coverage.status === "uncovered"))
  assert.ok(auditExclusions.some(({ routes }) => routes.includes("GET /health")))
  assert.ok(auditExclusions.some(({ routes }) => routes.includes("public static assets")))
  assert.equal(auditRolloutStatus.comprehensiveCoverage, false)
  for (const declaration of [...Object.values(orgAuditCoverage), ...otherAuditSurfaces.map(({ coverage }) => coverage)]) {
    assert.ok(declaration.capturePolicy && declaration.snapshotPolicy && declaration.failurePolicy && declaration.limitations)
    if (declaration.status === "uncovered") assert.deepEqual(declaration.actions, [])
  }
})

test("owner organization erasure removes tenant-scoped audit step claims with all audit history in one transaction", () => {
  const file = source("../src/routes/org/delete-organization.ts")
  const route = routes(file).find(({ method, path }) => method === "DELETE" && path === "/v1/org")
  assert.ok(route)
  assert.ok(calls(route.call, "ensureOwner").length)
  const transaction = descendants(route.call).filter(ts.isCallExpression).find((call) => ts.isPropertyAccessExpression(call.expression) && call.expression.getText(file) === "db.transaction")
  assert.ok(transaction)
  const callback = transaction.arguments[0]
  assert.ok(callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body))
  const statements = callback.body.statements.filter(ts.isExpressionStatement).flatMap((statement) =>
    ts.isAwaitExpression(statement.expression) && ts.isCallExpression(statement.expression.expression) ? [statement.expression.expression] : [],
  )
  const normalized = statements.map((statement) => statement.getText(file).replace(/\s+/g, ""))
  const fence = normalized.indexOf('tx.select().from(AuditStateTable).where(eq(AuditStateTable.organization_id,organizationId)).for("update")')
  assert.ok(fence >= 0, "Audit appenders must be fenced before erasure")
  const expected = [
    ["AuditEventResourceTable", "organization_id"],
    ["AuditEventTable", "org_id"],
    ["AuditOperationStepTable", "organization_id"],
    ["AuditOperationTable", "organization_id"],
    ["AuditUsageFactTable", "organization_id"],
    ["AuditPolicyTable", "organization_id"],
    ["AuditStateTable", "organization_id"],
  ]
  let previous = fence
  for (const [table, column] of expected) {
    const statement = `tx.delete(${table}).where(eq(${table}.${column},organizationId))`
    assert.equal(normalized.filter((value) => value === statement).length, 1, `${table} must be deleted once with tenant scope`)
    const position = normalized.indexOf(statement)
    assert.ok(position > previous, `${table} must follow the fence and its child records`)
    previous = position
  }
})

test("worker cascade deletes worker-owned resources but never audit history or operation step claims", () => {
  const file = source("../src/routes/workers/shared.ts")
  const declaration = file.statements.filter(ts.isFunctionDeclaration).find((node) => node.name?.text === "deleteWorkerCascade")
  assert.ok(declaration?.body)
  const deletes = descendants(declaration.body).filter(ts.isCallExpression).filter((call) => ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "delete")
  const tables = deletes.map((call) => {
    assert.ok(call.arguments[0] && ts.isIdentifier(call.arguments[0]), "Review indirect deletion explicitly")
    return call.arguments[0].text
  })
  assert.deepEqual(tables, ["WorkerTokenTable", "CloudRuntimeInstanceTable", "DaytonaSandboxTable", "WorkerInstanceTable", "WorkerBundleTable", "WorkerTable"])
  assert.equal(descendants(declaration.body).some((node) => ts.isIdentifier(node) && /^Audit.*Table$/.test(node.text)), false, "Worker resource cleanup must not mutate audit storage")
})

test("self-hosted deployment configuration separates entitlement, capture rollout and visibility", () => {
  const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8")
  const values = readFileSync(new URL("../../../../packaging/helm/openwork-ee/values.yaml", import.meta.url), "utf8")
  const config = readFileSync(new URL("../../../../packaging/helm/openwork-ee/templates/configmap.yaml", import.meta.url), "utf8")
  for (const [envName, key] of [["DEN_AUDIT_SELF_HOSTED_ENABLED", "selfHostedEnabled"], ["DEN_AUDIT_CAPTURE_ENABLED", "captureEnabled"], ["DEN_AUDIT_VISIBILITY_ENABLED", "visibilityEnabled"]]) {
    assert.ok(envExample.includes(`${envName}=false`))
    assert.ok(values.includes(`${key}: "false"`))
    assert.ok(config.includes(`${envName}: {{ .Values.config.audit.${key} | quote }}`))
  }
})

test("manual pilot has no billing products, deletion, update path, HTTP route, env writes or scheduled cleanup", () => {
  for (const path of ["../src/audit/pilot-policy.ts", "../scripts/audit-pilot.ts"]) {
    const file = source(path)
    const imports = descendants(file).flatMap((node) => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) ? [node.moduleSpecifier.text] : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0]) ? [node.arguments[0].text] : [])
    assert.ok(imports.every((name) => /^(?:node:(?:url|util)|@openwork-ee\/den-db\/(?:audit-log|audit-accounting|drizzle|schema)|@openwork-ee\/utils\/typeid|@openwork\/types\/den\/audit|zod|\.\.\/src\/(?:audit\/pilot-policy|env|db)\.js)$/.test(name)), imports.join(","))
    for (const call of descendants(file).filter(ts.isCallExpression)) {
      const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : call.expression.getText(file)
      assert.equal(["delete", "update", "execute", "fetch", "setInterval", "setTimeout", "exec", "spawn", "schedule"].includes(name), false, name)
    }
    assert.equal(descendants(file).some((node) => ts.isPropertyAccessExpression(node) && node.getText(file) === "process.env"), false)
  }
  assert.equal(auditRolloutStatus.paidOverage, false)
  assert.equal(auditRolloutStatus.deletionEnabled, false)
  assert.equal(auditRolloutStatus.scheduledCleanup, false)
})
