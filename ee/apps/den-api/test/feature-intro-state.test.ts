import assert from "node:assert/strict"
import { test } from "node:test"
import { featureIntroEventRequestSchema, featureIntroStateSchema } from "@openwork/types/den/feature-intros"
import { auditRouteDeclarations, auditRouteEventTypes } from "../src/audit/routes/index.js"
import { applyFeatureIntroEvent, featureIntroStateView, type FeatureIntroTimestamps } from "../src/feature-intro-state.js"

const day1 = new Date("2026-11-01T09:00:00.000Z")
const day2 = new Date("2026-11-02T09:00:00.000Z")
const day3 = new Date("2026-11-03T09:00:00.000Z")
const empty: FeatureIntroTimestamps = { introVersion: 1, firstSeenAt: null, lastSeenAt: null, dismissedAt: null, ctaClickedAt: null, completedAt: null }

test("seen keeps the first time and moves the last; dismissed and cta_clicked set their own time", () => {
  const seen = applyFeatureIntroEvent(empty, { introVersion: 1, type: "seen" }, day1)
  assert.deepEqual(seen, { ...empty, firstSeenAt: day1, lastSeenAt: day1 })
  const again = applyFeatureIntroEvent(seen, { introVersion: 1, type: "seen" }, day2)
  assert.deepEqual(again, { ...empty, firstSeenAt: day1, lastSeenAt: day2 })
  const dismissed = applyFeatureIntroEvent(again, { introVersion: 1, type: "dismissed" }, day3)
  assert.deepEqual(dismissed, { ...empty, firstSeenAt: day1, lastSeenAt: day2, dismissedAt: day3 })
  const clicked = applyFeatureIntroEvent(dismissed, { introVersion: 1, type: "cta_clicked" }, day3)
  assert.equal(clicked?.ctaClickedAt, day3)
  assert.equal(clicked?.dismissedAt, day3)
})

test("a newer version resets every timestamp before applying the event; an older one changes nothing", () => {
  const stored: FeatureIntroTimestamps = { introVersion: 2, firstSeenAt: day1, lastSeenAt: day2, dismissedAt: day2, ctaClickedAt: day2, completedAt: day2 }
  assert.deepEqual(applyFeatureIntroEvent(stored, { introVersion: 3, type: "dismissed" }, day3), { ...empty, introVersion: 3, dismissedAt: day3 })
  assert.equal(applyFeatureIntroEvent(stored, { introVersion: 1, type: "seen" }, day3), null)
  assert.deepEqual(applyFeatureIntroEvent(null, { introVersion: 4, type: "seen" }, day3), { ...empty, introVersion: 4, firstSeenAt: day3, lastSeenAt: day3 })
})

test("the view matches the shared contract and the request schema bounds keys", () => {
  const view = featureIntroStateView("ai-gateway.limits", { ...empty, firstSeenAt: day1, lastSeenAt: day2 })
  assert.deepEqual(view, { introKey: "ai-gateway.limits", introVersion: 1, firstSeenAt: day1.toISOString(), lastSeenAt: day2.toISOString(), dismissedAt: null, ctaClickedAt: null })
  assert.equal(featureIntroStateSchema.safeParse(view).success, true)
  for (const field of ["firstSeenAt", "lastSeenAt", "dismissedAt", "ctaClickedAt"]) {
    assert.equal(featureIntroStateSchema.safeParse({ ...view, [field]: day3.toISOString() }).success, true, field)
    assert.equal(featureIntroStateSchema.safeParse({ ...view, [field]: null }).success, true, field)
    assert.equal(featureIntroStateSchema.safeParse({ ...view, [field]: "not-a-timestamp" }).success, false, field)
  }
  assert.equal(featureIntroEventRequestSchema.safeParse({ introKey: "members.teams", introVersion: 1, type: "seen" }).success, true)
  for (const introKey of ["", "AI-Gateway", "ai gateway", ".members", "members.", "a".repeat(121)]) {
    assert.equal(featureIntroEventRequestSchema.safeParse({ introKey, introVersion: 1, type: "seen" }).success, false, introKey)
  }
  assert.equal(featureIntroEventRequestSchema.safeParse({ introKey: "members", introVersion: 0, type: "seen" }).success, false)
  assert.equal(featureIntroEventRequestSchema.safeParse({ introKey: "members", introVersion: 1, type: "completed" }).success, false)
})

test("each feature intro endpoint declares tenant evidence attributed by organization context", () => {
  for (const [method, path, auditClass, event] of [
    ["GET", "/v1/me/feature-intros", "tenant_read", "feature_intro.list.served"],
    ["POST", "/v1/me/feature-intros/events", "tenant_signal", "feature_intro.event.report.observed"],
  ]) {
    const matches = auditRouteDeclarations.filter((entry) => entry.method === method && entry.path === path)
    assert.equal(matches.length, 1, `${method} ${path}`)
    const declaration = matches[0]
    assert.ok(declaration)
    assert.equal(declaration.class, auditClass)
    assert.equal(declaration.attribution, "org_context")
    assert.equal(declaration.resource.type, "feature_intro_state")
    assert.ok(auditRouteEventTypes(declaration).includes(event), auditRouteEventTypes(declaration).join(", "))
  }
})
