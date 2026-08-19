import { createHash } from "node:crypto"
import { expect } from "vitest"
import { test } from "@openwork/testkit"
import { AuthVerificationTable } from "../../ee/packages/den-db/src/schema/auth.js"

test(
  "SAML replay reservations accept Better Auth's deterministic verification ID",
  async ({ evidence }) => {
    const reservationId = createHash("sha256")
      .update("reserve:saml-used-assertion:_okta-assertion-id")
      .digest("base64url")
    const driverValue = AuthVerificationTable.id.mapToDriverValue(reservationId)

    expect(reservationId).toHaveLength(43)
    expect(driverValue).toBe(reservationId)
    evidence.recordAssertionEvidence(
      "Better Auth's SAML replay reservation reaches the verification table unchanged",
      `The 43-character reservation ID round-tripped as ${driverValue}.`,
      driverValue === reservationId,
    )
  },
)
