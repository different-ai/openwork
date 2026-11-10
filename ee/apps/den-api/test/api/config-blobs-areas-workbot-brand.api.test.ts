import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { after, test } from "node:test"
import { and, count, eq } from "@openwork-ee/den-db/drizzle"
import { AuditOperationTable, ConfigObjectTable, ConfigObjectVersionTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { ConfigFieldChange } from "@openwork/types/den/config-blobs"
import sharp from "sharp"
import { ConfigApplyItemError, type ConfigArea, type ConfigAreaContext, type ConfigItem } from "../../src/config-blobs/area.js"
import { bootDen, field, summary, type Call, type Member } from "./harness.js"

// workbot.settings, workbot.proactive, settings.audit and settings.advanced.brand: export, readItems, minimal
// writes and a round trip into a second organization. No runner, Slack or image host is contacted.
const den = await bootDen({ env: { DEN_WORKBOT_URL: "http://localhost:3020", DEN_AUDIT_CAPTURE_ENABLED: "true", DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(async () => { await den.close() })
const { db } = await import("../../src/db.js")
const { getOrganizationFeatures } = await import("../../src/features.js")
const { databaseBrandAssetStorage } = await import("../../src/brand-asset-storage.js")
const { uploadedAsset, brandAssetPublicBaseUrl } = await import("../../src/routes/org/brand-assets.js")
const { updateOrganizationSettings } = await import("../../src/orgs.js")
const { env } = await import("../../src/env.js")
const { workbotSettingsArea } = await import("../../src/config-blobs/areas/workbot-settings.js")
const { workbotProactiveArea } = await import("../../src/config-blobs/areas/workbot-proactive.js")
const { settingsAuditArea } = await import("../../src/config-blobs/areas/settings-audit.js")
const { settingsBrandArea } = await import("../../src/config-blobs/areas/settings-brand.js")

const AREAS: ConfigArea[] = [workbotSettingsArea, workbotProactiveArea, settingsAuditArea, settingsBrandArea]

async function ok(call: Promise<Call>, label: string) {
  const result = await call
  assert.ok(result.status < 300, `${label}: ${summary(result)}`)
  return result
}

async function contextFor(orgId: string, actor: Member): Promise<ConfigAreaContext> {
  return { db, organizationId: orgId, actor: { userId: actor.userId, memberId: actor.memberId }, deployment: "self_hosted", features: await getOrganizationFeatures(orgId, { userId: actor.userId }) }
}

async function only(area: ConfigArea, ctx: ConfigAreaContext): Promise<ConfigItem> {
  const items = await area.exportItems(ctx)
  assert.equal(items.length, 1, area.key)
  const [item] = items
  assert.ok(item)
  return item
}

/** Top-level field changes between two specs, the way the plan names them (enough for these areas). */
function changesBetween(from: ConfigItem["spec"], to: ConfigItem["spec"]): ConfigFieldChange[] {
  return [...new Set([...Object.keys(from), ...Object.keys(to)])]
    .filter((key) => JSON.stringify(from[key]) !== JSON.stringify(to[key]))
    .map((path) => ({ path, from: from[path], to: to[path] }))
}

async function templateVersions(orgId: string): Promise<number> {
  const [row] = await db
    .select({ versions: count() })
    .from(ConfigObjectVersionTable)
    .innerJoin(ConfigObjectTable, eq(ConfigObjectTable.id, ConfigObjectVersionTable.configObjectId))
    .where(and(eq(ConfigObjectTable.organizationId, normalizeDenTypeId("organization", orgId)), eq(ConfigObjectTable.objectType, "agent")))
  return row?.versions ?? 0
}

async function setStoredModel(orgId: string, model: string) {
  const [row] = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, normalizeDenTypeId("organization", orgId)))
  const metadata: Record<string, unknown> = typeof row?.metadata === "object" && row.metadata !== null ? { ...row.metadata } : {}
  const workbot = metadata.workbot
  await db.update(OrganizationTable).set({ metadata: { ...metadata, workbot: { ...(typeof workbot === "object" && workbot !== null ? workbot : {}), model } } }).where(eq(OrganizationTable.id, normalizeDenTypeId("organization", orgId)))
}

// ---------------------------------------------------------------------------
// Source organization, set up through the public API where it has one.

const owner = await den.signUp("Brand Owner")
const source = await den.createOrg(owner, "Brand Source")
const as = den.as(owner, source.orgId)
assert.equal((await den.setFeature(source.orgId, "workbotProactive", true)).status, 200)
await ok(as("PUT", "/v1/org/workbot-settings/proactive", {
  enabled: true, leadMinutes: 30, startHour: 9, dailyCap: 5, membersStart: "opted_out",
  sources: { email: "members" }, responsibilities: { meeting_prep: false }, instructions: "Keep it short.",
}), "proactive settings")
await setStoredModel(source.orgId, "custom/not-a-served-model")
await ok(as("PATCH", "/v1/org", { brandAppName: "Acme Work", brandAccentColor: "#ff6600" }), "brand name")
const usage = await ok(as("GET", "/v1/audit/usage"), "audit usage")
await ok(as("PATCH", "/v1/audit/settings", { captureOn: false, expectedRevision: Number(field(usage.body, "policy", "revision")) }), "audit off")

// A wordmark uploaded through the upload route's own function.
const logoPng = await sharp({ create: { width: 256, height: 64, channels: 4, background: { r: 20, g: 120, b: 220, alpha: 1 } } }).png().toBuffer()
const uploaded = await uploadedAsset({
  file: new File([Uint8Array.from(logoPng)], "acme-wordmark.png", { type: "image/png" }),
  kind: "logo",
  organizationId: normalizeDenTypeId("organization", source.orgId),
  storage: databaseBrandAssetStorage,
  assetPublicBaseUrl: brandAssetPublicBaseUrl(),
  signingSecret: env.betterAuthSecret,
})
assert.ok(uploaded.ok)
await updateOrganizationSettings({ organizationId: normalizeDenTypeId("organization", source.orgId), brandLogoUrl: uploaded.metadata.url, brandLogoAsset: uploaded.metadata })
const sourceLogoBytes = await databaseBrandAssetStorage.read({ organizationId: normalizeDenTypeId("organization", source.orgId), kind: "logo", version: uploaded.metadata.version, extension: "png" })
assert.ok(sourceLogoBytes)

const sourceCtx = await contextFor(source.orgId, source.owner)

// ---------------------------------------------------------------------------

test("export: allowlisted single items, valid specs, no secrets or source-bound URLs", async () => {
  const exported = new Map<string, ConfigItem>()
  for (const area of AREAS) {
    const item = await only(area, sourceCtx)
    assert.equal(item.id, source.orgId, area.key)
    const parsed = area.specSchema.safeParse(item.spec)
    assert.ok(parsed.success, `${area.key}: ${parsed.success ? "" : parsed.error.message}`)
    exported.set(area.key, item)
  }
  const text = JSON.stringify(Object.fromEntries(exported))
  for (const forbidden of ["signature", "/v1/brand-assets/", "token", "secret", "slack", "uploadedAt", "versionId"]) {
    assert.ok(!text.toLowerCase().includes(forbidden.toLowerCase()), `export contains ${forbidden}`)
  }

  assert.deepEqual(exported.get("workbot.settings")?.spec, { model: "custom/not-a-served-model", provider: null, maxSteps: null, enabled: true })
  const proactive = exported.get("workbot.proactive")?.spec
  assert.deepEqual(proactive, {
    enabled: true, leadMinutes: 30, workingDays: "weekdays", startHour: 9, endHour: 19, dailyCap: 5, membersStart: "opted_out", destination: "workbot_dm",
    sources: {
      calendar: "everyone", email: "members", chat: "everyone",
      coreConnections: { calendar: null, email: null, chat: null },
      coreDefaults: { calendar: null, email: null, chat: null },
      otherConnections: null, connections: [], toolOverrides: [],
    },
    brief: {},
    template: { responsibilities: { morning_brief: true, meeting_prep: false, calendar_changes: true, waiting_on_you: true }, instructions: "Keep it short." },
  })
  assert.deepEqual(exported.get("settings.audit")?.spec, { captureOn: false })
  const brand = exported.get("settings.advanced.brand")?.spec
  assert.equal(brand?.appName, "Acme Work")
  assert.equal(brand?.accentColor, "#ff6600")
  assert.equal(brand?.icon, null)
  const logo = brand?.logo
  assert.ok(typeof logo === "object" && logo !== null && !Array.isArray(logo))
  assert.equal(field(logo, "source"), "upload")
  assert.equal(field(logo, "sha256"), uploaded.metadata.version)
  assert.equal(field(logo, "contentType"), "image/png")
  assert.equal(field(logo, "originalName"), "acme-wordmark.png")
  assert.equal(field(logo, "data"), Buffer.from(sourceLogoBytes).toString("base64"))

  // Exports are stable.
  for (const area of AREAS) assert.equal(JSON.stringify(await only(area, sourceCtx)), JSON.stringify(exported.get(area.key)))
})

test("readItems: the one item by the organization id, nothing for other ids", async () => {
  for (const area of AREAS) {
    assert.ok(area.readItems, area.key)
    const items = await area.readItems(sourceCtx, [source.orgId])
    assert.deepEqual(items, await area.exportItems(sourceCtx), area.key)
    assert.deepEqual(await area.readItems(sourceCtx, ["org_00000000000000000000000000"]), [], area.key)
  }
})

test("delete is refused and protected", async () => {
  for (const area of AREAS) {
    const item = await only(area, sourceCtx)
    assert.ok(area.protectedFromDelete?.(item, sourceCtx), area.key)
    await assert.rejects(area.apply(sourceCtx, { kind: "delete", targetId: item.id, previous: item }), (error: unknown) => error instanceof ConfigApplyItemError && error.failure.code === "not_deletable")
  }
})

test("update writes only what the plan's changes name", async () => {
  const before = await only(workbotProactiveArea, sourceCtx)
  const versions = await templateVersions(source.orgId)
  // The spec also differs in dailyCap and the instructions, but the plan only changes startHour.
  const spec = { ...before.spec, startHour: 7, dailyCap: 2, template: { ...Object(before.spec.template), instructions: "Changed" } }
  const result = await workbotProactiveArea.apply(sourceCtx, {
    kind: "update", targetId: source.orgId, previous: before,
    item: { name: before.name, spec }, changes: [{ path: "startHour", from: 9, to: 7 }], secretPaths: [],
  })
  assert.deepEqual(result.steps, [{ action: "set", target: "startHour" }])
  const after = await only(workbotProactiveArea, sourceCtx)
  assert.deepEqual(after.spec, { ...before.spec, startHour: 7 })
  assert.equal(await templateVersions(source.orgId), versions, "no template version for an untouched template")

  // Same spec as stored: nothing is written.
  const noop = await workbotProactiveArea.apply(sourceCtx, {
    kind: "update", targetId: source.orgId, previous: after, item: { name: after.name, spec: after.spec },
    changes: [{ path: "startHour", from: 9, to: 7 }], secretPaths: [],
  })
  assert.deepEqual(noop.steps, [])

  // Put it back.
  await workbotProactiveArea.apply(sourceCtx, {
    kind: "update", targetId: source.orgId, previous: after, item: { name: after.name, spec: before.spec },
    changes: [{ path: "startHour", from: 7, to: 9 }], secretPaths: [],
  })
  assert.deepEqual((await only(workbotProactiveArea, sourceCtx)).spec, before.spec)

  // Brand: only the app name.
  const brand = await only(settingsBrandArea, sourceCtx)
  const renamed = await settingsBrandArea.apply(sourceCtx, {
    kind: "update", targetId: source.orgId, previous: brand,
    item: { name: brand.name, spec: { ...brand.spec, appName: "Acme Two", accentColor: "#000000" } },
    changes: [{ path: "appName", from: "Acme Work", to: "Acme Two" }], secretPaths: [],
  })
  assert.deepEqual(renamed.steps?.map((step) => step.target), ["appName"])
  const afterBrand = await only(settingsBrandArea, sourceCtx)
  assert.deepEqual(afterBrand.spec, { ...brand.spec, appName: "Acme Two" })
  await settingsBrandArea.apply(sourceCtx, {
    kind: "update", targetId: source.orgId, previous: afterBrand, item: { name: brand.name, spec: brand.spec },
    changes: [{ path: "appName", from: "Acme Two", to: "Acme Work" }], secretPaths: [],
  })
})

test("round trip into a second organization; brand bytes identical; a model the applier can't use fails on its field", async () => {
  const targetOwner = await den.signUp("Brand Target Owner")
  const target = await den.createOrg(targetOwner, "Brand Target")
  assert.equal((await den.setFeature(target.orgId, "workbotProactive", true)).status, 200)
  const targetCtx = await contextFor(target.orgId, target.owner)

  for (const area of [workbotProactiveArea, settingsAuditArea, settingsBrandArea]) {
    const blob = await only(area, sourceCtx)
    const previous = await only(area, targetCtx)
    const changes = changesBetween(previous.spec, blob.spec)
    assert.ok(changes.length > 0, `${area.key}: the target starts different`)
    const result = await area.apply(targetCtx, {
      kind: "update", targetId: target.orgId, previous, item: { sourceId: blob.id, name: blob.name, spec: blob.spec }, changes, secretPaths: [],
    })
    assert.equal(result.localId, target.orgId)
    assert.ok((result.steps ?? []).length > 0, area.key)
    assert.deepEqual((await only(area, targetCtx)).spec, blob.spec, `${area.key} round trip`)

    // A second apply of the same spec writes nothing.
    const again = await only(area, targetCtx)
    const noop = await area.apply(targetCtx, { kind: "update", targetId: target.orgId, previous: again, item: { name: blob.name, spec: blob.spec }, changes, secretPaths: [] })
    assert.deepEqual(noop.steps, [], `${area.key} second apply`)
  }

  // Irreversible effects are named before approval.
  const proactive = await only(workbotProactiveArea, sourceCtx)
  const fresh = { id: target.orgId, name: proactive.name, spec: { ...proactive.spec, enabled: false } }
  assert.equal(workbotProactiveArea.irreversible?.({ kind: "update", targetId: target.orgId, previous: fresh, item: { name: proactive.name, spec: proactive.spec }, changes: [{ path: "enabled" }], secretPaths: [] }).length, 1)

  const targetBrand = await only(settingsBrandArea, targetCtx)
  const targetLogo = targetBrand.spec.logo
  assert.equal(field(targetLogo, "sha256"), uploaded.metadata.version)
  const targetBytes = await databaseBrandAssetStorage.read({ organizationId: normalizeDenTypeId("organization", target.orgId), kind: "logo", version: uploaded.metadata.version, extension: "png" })
  assert.ok(targetBytes)
  assert.ok(Buffer.from(targetBytes).equals(Buffer.from(sourceLogoBytes)), "logo bytes are identical")
  assert.equal(createHash("sha256").update(Buffer.from(targetBytes)).digest("hex"), uploaded.metadata.version)
  const [targetRow] = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, normalizeDenTypeId("organization", target.orgId)))
  const logoUrl = String(field(targetRow?.metadata, "brandLogoUrl"))
  assert.ok(logoUrl.includes(`/v1/brand-assets/${target.orgId}/logo/`), "the target signs its own asset URL")

  // A tampered image is refused on its field, before anything is written.
  const tampered = { ...targetBrand.spec, logo: { ...Object(targetBrand.spec.logo), sha256: "a".repeat(64) }, icon: null }
  await assert.rejects(settingsBrandArea.apply(targetCtx, {
    kind: "update", targetId: target.orgId, previous: { ...targetBrand, spec: { ...targetBrand.spec, logo: null } }, item: { name: targetBrand.name, spec: tampered },
    changes: [{ path: "logo" }], secretPaths: [],
  }), (error: unknown) => error instanceof ConfigApplyItemError && error.failure.code === "asset_hash_mismatch" && error.failure.field === "logo.data" && error.stepsDone.length === 0)

  // workbot.settings: the source's model isn't one the applier can use here.
  const settings = await only(workbotSettingsArea, sourceCtx)
  const targetSettings = await only(workbotSettingsArea, targetCtx)
  assert.deepEqual(targetSettings.spec, { model: null, provider: null, maxSteps: null, enabled: true })
  await assert.rejects(workbotSettingsArea.apply(targetCtx, {
    kind: "update", targetId: target.orgId, previous: targetSettings, item: { name: settings.name, spec: settings.spec }, changes: [{ path: "model" }], secretPaths: [],
  }), (error: unknown) => error instanceof ConfigApplyItemError && ["unknown_model", "workbot_runner_unavailable"].includes(error.failure.code) && error.failure.field === "model" && error.failure.step?.target === "model")
  assert.deepEqual((await only(workbotSettingsArea, targetCtx)).spec, { model: null, provider: null, maxSteps: null, enabled: true }, "nothing was written")

  // The default (null) is always allowed: clearing the source's model works.
  const cleared = await workbotSettingsArea.apply(sourceCtx, {
    kind: "update", targetId: source.orgId, previous: settings, item: { name: settings.name, spec: { model: null, provider: null, maxSteps: null, enabled: true } }, changes: [{ path: "model" }], secretPaths: [],
  })
  assert.deepEqual(cleared.steps, [{ action: "set", target: "model", detail: "default" }])
  assert.deepEqual((await only(workbotSettingsArea, sourceCtx)).spec, { model: null, provider: null, maxSteps: null, enabled: true })
})

test("workbot.settings carries Workbot's step limit and applies it only where workbotStepLimit is on", async () => {
  const stepOwner = await den.signUp("Step Limit Blob Owner")
  const org = await den.createOrg(stepOwner, "Step limit blob org")
  const ctx = await contextFor(org.orgId, org.owner)
  const before = await only(workbotSettingsArea, ctx)
  assert.equal(before.spec.maxSteps, null, "the deployment default is exported as null")
  const update = (maxSteps: number | null, previous: typeof before) => workbotSettingsArea.apply(ctx, {
    kind: "update", targetId: org.orgId, previous, item: { name: previous.name, spec: { ...previous.spec, maxSteps } }, changes: [{ path: "maxSteps" }], secretPaths: [],
  })

  // Off: nothing is written, and the report says why.
  const off = await update(40, before)
  assert.deepEqual(off.steps, [])
  assert.match(off.warnings?.join(" ") ?? "", /step limit isn't on/)
  assert.equal((await only(workbotSettingsArea, ctx)).spec.maxSteps, null)

  // On: only the step limit is written; the model is untouched.
  assert.equal((await den.setFeature(org.orgId, "workbotStepLimit", true)).status, 200)
  const on = await update(40, before)
  assert.deepEqual(on.steps, [{ action: "set", target: "maxSteps", detail: "40" }])
  const after = await only(workbotSettingsArea, ctx)
  assert.equal(after.spec.maxSteps, 40)
  assert.equal(after.spec.model, before.spec.model)

  // 0 means no limit, and an unchanged value writes nothing.
  assert.deepEqual((await update(0, after)).steps, [{ action: "set", target: "maxSteps", detail: "no limit" }])
  assert.deepEqual((await update(0, await only(workbotSettingsArea, ctx))).steps, [])
})

test("settings.audit: the capture change names the config token the apply runs under", async () => {
  const auditOwner = await den.signUp("Audit Token Owner")
  const org = await den.createOrg(auditOwner, "Audit token org")
  const apiKeyId = `apikey-config-${den.stamp}`
  const ctx: ConfigAreaContext = { ...await contextFor(org.orgId, org.owner), actor: { userId: org.owner.userId, memberId: org.owner.memberId, apiKeyId } }
  const previous = await only(settingsAuditArea, ctx)
  const captureOn = previous.spec.captureOn !== true
  const result = await settingsAuditArea.apply(ctx, {
    kind: "update", targetId: org.orgId, previous, item: { name: previous.name, spec: { captureOn } }, changes: [{ path: "captureOn" }], secretPaths: [],
  })
  assert.deepEqual(result.steps?.map((step) => step.target), ["captureOn"])
  const operations = await db
    .select({ principalKey: AuditOperationTable.principal_key, initiatingActor: AuditOperationTable.initiating_actor })
    .from(AuditOperationTable)
    .where(and(eq(AuditOperationTable.organization_id, normalizeDenTypeId("organization", org.orgId)), eq(AuditOperationTable.kind, "audit.policy")))
  // Besides the system's own initialization of the policy: the member's change, under the token.
  const byMember = operations.filter((operation) => operation.principalKey.startsWith("user:"))
  assert.ok(byMember.length > 0, `the capture change was audited: ${JSON.stringify(operations)}`)
  assert.ok(byMember.every((operation) => operation.principalKey.endsWith(`:key:${apiKeyId}`)), JSON.stringify(byMember))
  assert.ok(byMember.every((operation) => field(operation.initiatingActor, "credentialId") === apiKeyId), JSON.stringify(byMember))
})

test("workbot.proactive carries the saved brief only while workbotAgentBrief is on; an import without it leaves it alone", async () => {
  const { readProactiveSettings } = await import("../../src/workbot-proactive/access.js")
  const organizationId = normalizeDenTypeId("organization", source.orgId)
  assert.equal((await den.setFeature(source.orgId, "workbotAgentBrief", true)).status, 200)
  await ok(as("PUT", "/v1/org/workbot-settings/proactive", { brief: { text: "Only what matters today.", checkEveryHours: 2 } }), "save the brief")
  const on = await only(workbotProactiveArea, sourceCtx)
  assert.deepEqual(on.spec.brief, { text: "Only what matters today.", checkEveryHours: 2 })

  assert.equal((await den.setFeature(source.orgId, "workbotAgentBrief", false)).status, 200)
  try {
    const off = await only(workbotProactiveArea, sourceCtx)
    assert.deepEqual(off.spec.brief, {}, "the saved brief stays out of the export while the feature is off")
    assert.ok(!JSON.stringify(off).includes("Only what matters today."))
    // Re-importing that export (the brief left out, as a plan's diff would name it) never clears the saved brief.
    const result = await workbotProactiveArea.apply(sourceCtx, {
      kind: "update", targetId: source.orgId, previous: on, item: { name: off.name, spec: off.spec },
      changes: [{ path: "brief.text", from: "Only what matters today." }, { path: "brief.checkEveryHours", from: 2 }], secretPaths: [],
    })
    assert.deepEqual(result.steps, [])
    assert.deepEqual((await readProactiveSettings(organizationId)).brief, { text: "Only what matters today.", checkEveryHours: 2 })
    // A brief in the file isn't written while the feature is off either.
    const written = await workbotProactiveArea.apply(sourceCtx, {
      kind: "update", targetId: source.orgId, previous: off, item: { name: off.name, spec: { ...off.spec, brief: { text: "Imported brief" } } },
      changes: [{ path: "brief.text", to: "Imported brief" }], secretPaths: [],
    })
    assert.deepEqual(written.steps, [])
    assert.ok((written.warnings ?? []).some((warning) => warning.includes("brief isn't on")), JSON.stringify(written.warnings))
    assert.equal((await readProactiveSettings(organizationId)).brief?.text, "Only what matters today.")
  } finally {
    // Last test of the file: the feature stays off, as the earlier tests ran.
    assert.equal((await den.setFeature(source.orgId, "workbotAgentBrief", false)).status, 200)
  }
})
