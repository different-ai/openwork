import assert from "node:assert/strict"
import { test } from "node:test"
import { DESKTOP_FREE_MODEL_ID, DESKTOP_FREE_PROVIDER_ID, desktopFreeProofRequested } from "@openwork/free-auto"
import { desktopAppRequiredFailure, statusFromRejection } from "../../../../apps/server/src/free-auto/responses.js"

process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:1/fixture"
process.env.DEN_DB_ENCRYPTION_KEY ??= "fixture-encryption-key-0000000000000000"
const { readAutoConfig } = await import("../src/free/shared/config.js")
const { desktopProofRequired } = await import("../src/free/desktop-access.js")

const base = { INFERENCE_FREE_ENABLED: "true", INFERENCE_FREE_OPENAI_API_KEY: "fixture", ANONYMOUS_ACCOUNTING_IDENTITY_KEY: "fixture-accounting-identity-key-000000" }

test("free models need a signed desktop only once a minimum desktop version is set", () => {
  assert.equal(desktopProofRequired(readAutoConfig(base)), false)
  const required = readAutoConfig({ ...base, DESKTOP_FREE_MIN_VERSION: "v0.18.73", WORKBOT_FREE_GRANT_SECRET: "w".repeat(48) })
  assert.equal(required.minimumVersion, "0.18.73")
  assert.equal(desktopProofRequired(required), true)
})

test("a minimum desktop version without the Workbot grant secret is refused at startup", () => {
  assert.throws(() => readAutoConfig({ ...base, DESKTOP_FREE_MIN_VERSION: "0.18.73" }), /WORKBOT_FREE_GRANT_SECRET/)
})

test("a server that cannot sign reports free models as desktop-only instead of asking for an update", () => {
  const failure = desktopAppRequiredFailure()
  assert.equal(desktopFreeProofRequested(failure.status, failure.payload()), false)
  const status = statusFromRejection(failure.payload(), { state: "unavailable", code: null, currentVersion: "", minimumVersion: null,
    providerID: DESKTOP_FREE_PROVIDER_ID, modelID: DESKTOP_FREE_MODEL_ID, allowance: null })
  assert.equal(status.code, "desktop_app_required")
  assert.notEqual(status.state, "update_required")
})
