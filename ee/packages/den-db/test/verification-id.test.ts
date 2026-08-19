import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { AuthVerificationTable } from "../src/schema/auth.js"

test("verification IDs accept Better Auth replay reservation hashes", () => {
  const reservationId = createHash("sha256")
    .update("reserve:saml-used-assertion:_okta-assertion-id")
    .digest("base64url")

  assert.equal(reservationId.length, 43)
  assert.equal(AuthVerificationTable.id.mapToDriverValue(reservationId), reservationId)
})

test("verification IDs preserve existing Den TypeIDs", () => {
  const denVerificationId = "ver_01m0at4fbkeh7sg7srtsw9yk82"

  assert.equal(AuthVerificationTable.id.mapToDriverValue(denVerificationId), denVerificationId)
})
