import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { isMemberAddEligibilityEnforced, parseMemberAddEligibilityConfig, type MemberAddPath } from "../src/member-add-eligibility-config.js"

describe("member-add eligibility flags", () => {
  test("defaults enforce only Den invitation create, as before", () => {
    const config = parseMemberAddEligibilityConfig({ mode: "observe", enforcePaths: undefined })
    assert.deepEqual(config.enforcePaths, ["invitation"])
    assert.equal(isMemberAddEligibilityEnforced("invitation", config), true)
    const observedPaths: MemberAddPath[] = ["acceptance", "bootstrap", "sso_jit", "scim", "better_auth_invitation", "better_auth_other"]
    for (const path of observedPaths) {
      assert.equal(isMemberAddEligibilityEnforced(path, config), false, path)
    }
  })

  test("observe mode never enforces a listed path other than invitation", () => {
    const config = parseMemberAddEligibilityConfig({ mode: "observe", enforcePaths: "invitation, acceptance,scim" })
    assert.equal(isMemberAddEligibilityEnforced("acceptance", config), false)
    assert.equal(isMemberAddEligibilityEnforced("scim", config), false)
  })

  test("enforce mode enforces exactly the listed paths, and invitation always", () => {
    const config = parseMemberAddEligibilityConfig({ mode: "enforce", enforcePaths: "acceptance,bootstrap" })
    assert.equal(isMemberAddEligibilityEnforced("acceptance", config), true)
    assert.equal(isMemberAddEligibilityEnforced("bootstrap", config), true)
    assert.equal(isMemberAddEligibilityEnforced("scim", config), false)
    assert.equal(isMemberAddEligibilityEnforced("invitation", config), true)
  })

  test("an unknown path fails the boot", () => {
    assert.throws(() => parseMemberAddEligibilityConfig({ mode: "enforce", enforcePaths: "acceptance,jit" }), /unknown path "jit"/)
  })
})
