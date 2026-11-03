import assert from "node:assert/strict"
import { createServer } from "node:http"
import { after, before, beforeEach, test } from "node:test"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/desktop_release_ceiling_unit_test"
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
process.env.BETTER_AUTH_SECRET ??= "synthetic-desktop-release-ceiling-test-secret-not-production"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-desktop-release-ceiling-test-key-not-production"

const { env } = await import("../src/env.js")
const { createDesktopReleaseSource } = await import("../src/desktop-releases.js")

// GitHub publishes desktops newer than the Den under test (0.18.40).
const githubReleases = ["v0.18.62", "v0.18.50", "v0.18.41", "v0.18.40", "v0.18.30"].map((tag_name) => ({
  draft: false,
  prerelease: false,
  tag_name,
}))

const github = createServer((_request, response) => {
  response.setHeader("Content-Type", "application/json")
  response.end(JSON.stringify(githubReleases))
})

before(async () => {
  await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", resolve))
})

after(async () => {
  await new Promise<void>((resolve) => github.close(() => resolve()))
})

beforeEach(() => {
  const address = github.address()
  assert.ok(address && typeof address === "object", "GitHub stand-in is listening")
  env.desktopReleasesMode = "github"
  env.desktopReleasesBaseUrl = `http://127.0.0.1:${address.port}`
  env.orgMode = "single_org"
  env.serviceVersion = "0.18.40"
})

test("a self-hosted Den never advertises a desktop newer than itself", async () => {
  const metadata = await createDesktopReleaseSource().getDesktopReleaseMetadata()

  assert.equal(metadata.latestAppVersion, "0.18.40")
  assert.deepEqual(metadata.publishedDesktopVersions, ["0.18.40", "0.18.30"])
})

test("a self-hosted Den caps the committed snapshot too", async () => {
  env.desktopReleasesMode = "static"
  env.serviceVersion = "0.17.0"

  const metadata = await createDesktopReleaseSource().getDesktopReleaseMetadata()

  assert.equal(metadata.latestAppVersion, "0.17.0")
  assert.ok(metadata.publishedDesktopVersions.length > 0)
  for (const version of metadata.publishedDesktopVersions) {
    assert.ok(!/^0\.1[89]\./.test(version), `${version} is newer than the Den`)
  }
})

test("hosted multi-org keeps the newest published desktop", async () => {
  env.orgMode = "multi_org"

  const metadata = await createDesktopReleaseSource().getDesktopReleaseMetadata()

  assert.equal(metadata.latestAppVersion, "0.18.62")
})

test("self-hosted dev and commit builds keep the full inventory", async () => {
  for (const serviceVersion of ["dev", "commit a0d6bd1", "0.18.40-rc.1"]) {
    env.serviceVersion = serviceVersion
    const metadata = await createDesktopReleaseSource().getDesktopReleaseMetadata()
    assert.equal(metadata.latestAppVersion, "0.18.62", serviceVersion)
  }
})
