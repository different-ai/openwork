import assert from "node:assert/strict"
import { test } from "node:test"
import { hasOpenWorkModelsAllowanceHttpMarker, OPENWORK_MODELS_ALLOWANCE_ERROR_CODE } from "@openwork/types/den/inference"
import { openWorkModelsAllowanceResponse } from "../src/models-allowance.js"

const now = Date.parse("2026-10-21T12:00:00.000Z")
const windowEndAt = new Date(now + 70 * 60_000)
const organizationId = "org_01aaaaaaaaaaaaaaaaaaaaaaaa"

test("a used-up OpenWork Models allowance is classified, not a rate limit", async () => {
  const response = openWorkModelsAllowanceResponse({
    limitedBy: "iob_01aaaaaaaaaaaaaaaaaaaaaaaa",
    windowType: "five_hour",
    limitedBucket: { limitAmount: 100, usedAmount: 120, windowEndAt },
  }, now)
  assert.equal(response.status, 429)
  assert.equal(hasOpenWorkModelsAllowanceHttpMarker(response), true)
  assert.equal(response.headers.get("x-should-retry"), "false")
  assert.equal(response.headers.get("retry-after"), String(70 * 60))
  assert.equal(response.headers.get("x-openwork-limit-reset-at"), windowEndAt.toISOString())
  assert.equal(response.headers.get("x-openwork-limit-window-type"), "five_hour")
  // Older desktops and the headless runner already recognise these.
  assert.equal(response.headers.get("x-openwork-limit-bucket-id"), "iob_01aaaaaaaaaaaaaaaaaaaaaaaa")
  const text = await response.text()
  const body: unknown = JSON.parse(text)
  assert.deepEqual(body, { error: {
    message: "Your workspace used its OpenWork Models allowance.", type: "usage_limit_error", param: null,
    code: OPENWORK_MODELS_ALLOWANCE_ERROR_CODE, source: "openwork_models",
  } })
  // Engines retry any error whose text names a 5xx/429 status or a rate limit, and the UI must never show org ids.
  assert.doesNotMatch(text, /\d/)
  assert.doesNotMatch(text, /rate.?limit|too many requests|exhausted/i)
  assert.doesNotMatch(text, new RegExp(organizationId))
})

test("an organization with no allowance configured is blocked without a reset time", () => {
  const response = openWorkModelsAllowanceResponse({ limitedBy: "inference_metadata", windowType: "monthly" }, now)
  assert.equal(hasOpenWorkModelsAllowanceHttpMarker(response), true)
  assert.equal(response.headers.get("x-should-retry"), "false")
  assert.equal(response.headers.get("retry-after"), null)
  assert.equal(response.headers.get("x-openwork-limit-reset-at"), null)
})

test("only the gateway's own markers classify a 429", () => {
  assert.equal(hasOpenWorkModelsAllowanceHttpMarker(new Response(null, { status: 429 })), false)
  assert.equal(hasOpenWorkModelsAllowanceHttpMarker(new Response(null, { status: 429, headers: {
    "x-openwork-error-code": OPENWORK_MODELS_ALLOWANCE_ERROR_CODE, "x-openwork-usage-state": "within_limit",
  } })), false)
  assert.equal(hasOpenWorkModelsAllowanceHttpMarker(new Response(null, { status: 503, headers: {
    "x-openwork-error-code": OPENWORK_MODELS_ALLOWANCE_ERROR_CODE, "x-openwork-usage-state": "blocked",
  } })), false)
})
