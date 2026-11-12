import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { FeatureIntroStateTable } from "@openwork-ee/den-db/schema"
import { bootDen, field, list, summary } from "./harness.js"

const den = await bootDen()
after(async () => { await den.close() })
const { db } = await import("../../src/db.js")

test("feature intros record each member's own state per organization", async () => {
  const workspace = await den.createOrg(await den.signUp("Avery Owner"), "Intro workspace")
  const owner = den.as(workspace.owner, workspace.orgId)

  const empty = await owner("GET", "/v1/me/feature-intros")
  assert.equal(empty.status, 200, summary(empty))
  assert.deepEqual(empty.body, { intros: [] })

  // Parallel tabs: one row, first seen kept.
  const seen = await Promise.all([1, 2, 3].map(() => owner("POST", "/v1/me/feature-intros/events", { introKey: "ai-gateway.limits", introVersion: 1, type: "seen" })))
  assert.deepEqual(seen.map((call) => call.status), [200, 200, 200], seen.map(summary).join("\n"))
  const rows = await db.select().from(FeatureIntroStateTable).where(eq(FeatureIntroStateTable.organizationId, workspace.orgId))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.memberId, workspace.owner.memberId)
  const firstSeenAt = field(field(seen[0]?.body, "intro"), "firstSeenAt")
  assert.equal(typeof firstSeenAt, "string")

  const dismissed = await owner("POST", "/v1/me/feature-intros/events", { introKey: "ai-gateway.limits", introVersion: 1, type: "dismissed" })
  assert.equal(dismissed.status, 200, summary(dismissed))
  const intro = field(dismissed.body, "intro")
  assert.equal(field(intro, "introKey"), "ai-gateway.limits")
  assert.equal(field(intro, "introVersion"), 1)
  assert.equal(field(intro, "firstSeenAt"), firstSeenAt)
  assert.equal(typeof field(intro, "dismissedAt"), "string")
  assert.equal(field(intro, "ctaClickedAt"), null)

  // A newer version shows the intro again; an older one changes nothing.
  const bumped = await owner("POST", "/v1/me/feature-intros/events", { introKey: "ai-gateway.limits", introVersion: 2, type: "cta_clicked" })
  assert.equal(bumped.status, 200, summary(bumped))
  const bumpedIntro = field(bumped.body, "intro")
  assert.equal(field(bumpedIntro, "introVersion"), 2)
  assert.equal(field(bumpedIntro, "firstSeenAt"), null)
  assert.equal(field(bumpedIntro, "dismissedAt"), null)
  assert.equal(typeof field(bumpedIntro, "ctaClickedAt"), "string")
  const stale = await owner("POST", "/v1/me/feature-intros/events", { introKey: "ai-gateway.limits", introVersion: 1, type: "seen" })
  assert.equal(stale.status, 200, summary(stale))
  assert.deepEqual(stale.body, bumped.body)

  // Bad input is refused before anything is stored.
  for (const body of [
    { introKey: "AI Gateway", introVersion: 1, type: "seen" },
    { introKey: "ai-gateway", introVersion: 0, type: "seen" },
    { introKey: "ai-gateway", introVersion: 1, type: "completed" },
  ]) {
    assert.equal((await owner("POST", "/v1/me/feature-intros/events", body)).status, 400, JSON.stringify(body))
  }

  // State is per member.
  const member = await den.newMember(workspace.owner, workspace.orgId, "Riley Member")
  const memberCall = den.as(member, workspace.orgId)
  assert.deepEqual((await memberCall("GET", "/v1/me/feature-intros")).body, { intros: [] })
  const ownerList = list(field((await owner("GET", "/v1/me/feature-intros")).body, "intros"))
  assert.deepEqual(ownerList.map((entry) => [entry.introKey, entry.introVersion]), [["ai-gateway.limits", 2]])
})
