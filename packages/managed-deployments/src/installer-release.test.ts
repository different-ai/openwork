import assert from "node:assert/strict"
import { test } from "node:test"
import {
  compareInstallerRelease, compareVersions, installerReleaseFolder, installerReleaseLabel, installerRevisionField, installerRevisionOf, isInstallerRevision, MAX_INSTALLER_REVISION,
} from "@openwork/managed-deployments/installer-release"
import * as lifecycle from "@openwork/managed-deployments/lifecycle"
import { deploymentRunSchema, installerRevisionSchema } from "@openwork/managed-deployments/schema"

test("an installer release is ordered by app version first, then by installer revision", () => {
  const order = (left: [string, number?], right: [string, number?]) => compareInstallerRelease({ version: left[0], installerRevision: left[1] }, { version: right[0], installerRevision: right[1] })
  assert.equal(order(["0.19.3"], ["0.19.3"]), 0)
  assert.equal(order(["0.19.3"], ["0.19.3", 1]), 0, "no revision is revision 1")
  assert.equal(order(["0.19.3"], ["0.19.3", 2]), -1)
  assert.equal(order(["0.19.3", 3], ["0.19.3", 2]), 1)
  assert.equal(order(["0.19.3", 10], ["0.19.3", 9]), 1, "revisions compare as numbers")
  assert.equal(order(["0.19.4"], ["0.19.3", 9]), 1, "a newer version outranks any revision of an older one")
  assert.equal(order(["0.19.3", 9], ["0.19.4"]), -1)
  assert.equal(order(["0.19.3-rc.1", 2], ["0.19.3"]), -1, "a prerelease precedes its release whatever its revision")
  assert.equal(compareInstallerRelease({ version: "0.19.3", installerRevision: null }, { version: "0.19.3" }), 0, "a stored null revision is revision 1")
  for (const invalid of [0, -1, 1.5, Number.NaN, MAX_INSTALLER_REVISION + 1]) {
    assert.equal(order(["0.19.3", invalid], ["0.19.3"]), null)
    assert.equal(order(["0.19.3"], ["0.19.3", invalid]), null)
  }
  assert.equal(order(["latest"], ["0.19.3"]), null)
  assert.equal(order(["0.19.3"], ["0.19"]), null)
})

test("versions compare exactly, numerically and by semantic prerelease order", () => {
  assert.equal(compareVersions("1.2.9", "1.2.10"), -1)
  assert.equal(compareVersions("9007199254740994.0.0", "9007199254740993.0.0"), 1, "exact beyond the safe integer range")
  assert.equal(compareVersions("1.0.0-alpha.9", "1.0.0-alpha.10"), -1)
  assert.equal(compareVersions("1.0.0-alpha.01", "1.0.0-alpha.1"), 0)
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1)
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1)
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1)
  assert.equal(compareVersions("1.0", "1.0.0"), null)
  assert.equal(lifecycle.compareVersions, compareVersions, "there is one comparator")
  assert.equal(lifecycle.compareInstallerRelease, compareInstallerRelease)
})

test("revision 1 is never written: its folder, coordinates and label are those of a release without revisions", () => {
  assert.equal(installerRevisionOf(undefined), 1)
  assert.equal(installerRevisionOf(null), 1)
  assert.equal(installerRevisionOf(4), 4)
  assert.deepEqual(installerRevisionField(undefined), {})
  assert.deepEqual(installerRevisionField(1), {})
  assert.deepEqual(installerRevisionField(2), { installerRevision: 2 })
  assert.equal(installerReleaseFolder("0.19.3"), "0.19.3")
  assert.equal(installerReleaseFolder("0.19.3", 1), "0.19.3")
  assert.equal(installerReleaseFolder("0.19.3", 2), "0.19.3_r2")
  assert.equal(installerReleaseLabel("0.19.3"), "0.19.3")
  assert.equal(installerReleaseLabel("0.19.3", null), "0.19.3")
  assert.equal(installerReleaseLabel("0.19.3", 2), "0.19.3 (revision 2)")
  for (const value of [1, 2, MAX_INSTALLER_REVISION]) assert.equal(isInstallerRevision(value), true)
  for (const value of [0, -1, 1.5, "2", null, undefined, MAX_INSTALLER_REVISION + 1]) {
    assert.equal(isInstallerRevision(value), false)
    assert.equal(installerRevisionSchema.safeParse(value).success, false)
  }
})

test("a run recorded before revisions existed is shown as revision 1", () => {
  const run = { id: "00000000-0000-4000-8000-000000000002", kind: "install", version: "0.19.3", state: "ready", createdAt: "2026-10-01T00:00:00.000Z", lastSeenAt: null, expiresAt: "2026-10-02T00:00:00.000Z", expired: false, events: [] }
  assert.equal(deploymentRunSchema.parse(run).installerRevision, 1)
  assert.equal(deploymentRunSchema.parse({ ...run, installerRevision: 3 }).installerRevision, 3)
})
