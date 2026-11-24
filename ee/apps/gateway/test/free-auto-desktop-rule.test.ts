import assert from "node:assert/strict"
import { test } from "node:test"
import type { FeatureMap } from "@openwork/features"
import { DESKTOP_FREE_MODEL_ID, DESKTOP_FREE_PROVIDER_ID, desktopFreeProofRequested } from "@openwork/free-auto"
import { freeAutoDesktopProofRequiredBy } from "@openwork-ee/den-db/organization-features"
import { desktopAppRequiredFailure, statusFromRejection } from "../../../../apps/server/src/free-auto/responses.js"

const features = (on: { freeAutoCrossOrgBudgets?: boolean; desktopOnlyFreeAuto?: boolean }) =>
  ({ freeAutoCrossOrgBudgets: false, desktopOnlyFreeAuto: false, ...on }) as FeatureMap

test("free models need a desktop when the organization is desktop-only or budgets are shared across organizations", () => {
  const off = features({})
  assert.equal(freeAutoDesktopProofRequiredBy(off, off), false)
  assert.equal(freeAutoDesktopProofRequiredBy(off, features({ desktopOnlyFreeAuto: true })), true)
  assert.equal(freeAutoDesktopProofRequiredBy(features({ freeAutoCrossOrgBudgets: true }), off), true)
  // Signed-out guests follow only the deployment-wide desktop-only switch.
  assert.equal(freeAutoDesktopProofRequiredBy(features({ freeAutoCrossOrgBudgets: true }), null), false)
  assert.equal(freeAutoDesktopProofRequiredBy(features({ desktopOnlyFreeAuto: true }), null), true)
})

test("a server that cannot sign reports free models as desktop-only instead of asking for an update", () => {
  const failure = desktopAppRequiredFailure()
  assert.equal(desktopFreeProofRequested(failure.status, failure.payload()), false)
  const status = statusFromRejection(failure.payload(), { state: "unavailable", code: null, currentVersion: "", minimumVersion: null,
    providerID: DESKTOP_FREE_PROVIDER_ID, modelID: DESKTOP_FREE_MODEL_ID, allowance: null })
  assert.equal(status.code, "desktop_app_required")
  assert.notEqual(status.state, "update_required")
})
