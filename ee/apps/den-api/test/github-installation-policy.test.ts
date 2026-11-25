import assert from "node:assert/strict"
import { test } from "node:test"
import {
  githubAccountInstallationId,
  GithubInstallationApprovalError,
  githubInstallationOwner,
  parseGithubInstallationBindings,
} from "../src/routes/org/plugin-system/github-installation-policy.js"

const denOrg = "org_00000000000000000000000001"
const otherDenOrg = "org_00000000000000000000000002"
const entry = { installationId: 12345, organizationId: denOrg }

test("deployment policy maps each approved installation to exactly one Den organization", () => {
  const config = parseGithubInstallationBindings(JSON.stringify([entry, { installationId: 12346, organizationId: otherDenOrg }]))
  assert.equal(githubInstallationOwner(config, 12345), denOrg)
  assert.equal(githubInstallationOwner(config, 12346), otherDenOrg)
  assert.equal(githubInstallationOwner(config, 12347), undefined)
})

test("missing, malformed, or ambiguous deployment policy grants no access", () => {
  for (const raw of [undefined, "", "[]", "{", "{}", "null"]) {
    assert.equal(githubInstallationOwner(parseGithubInstallationBindings(raw), entry.installationId), undefined)
  }
  for (const invalid of [
    { ...entry },
    { ...entry, organizationId: otherDenOrg },
    { ...entry, organizationId: "org-slug" },
    { ...entry, installationId: -1 },
    { ...entry, installationId: 1.5 },
    { ...entry, installationId: "12346" },
    { ...entry, installationId: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.equal(parseGithubInstallationBindings(JSON.stringify([entry, invalid])), null)
  }
})

test("persisted instance configuration cannot override the account's canonical installation ID", () => {
  assert.equal(githubAccountInstallationId("12345"), 12345)
  assert.equal(githubAccountInstallationId("12345", 12345), 12345)
  for (const legacyId of [12346, "12345", null, false]) {
    assert.throws(() => githubAccountInstallationId("12345", legacyId), GithubInstallationApprovalError)
  }
  for (const remoteId of ["012345", "1e4", "12345 ", "0", "9007199254740992"]) {
    assert.throws(() => githubAccountInstallationId(remoteId), GithubInstallationApprovalError)
  }
})
