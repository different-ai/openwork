import assert from "node:assert/strict"
import { test } from "node:test"
import { awsRelease, gcpRelease, releaseReadiness } from "../src/managed-deployments/config.js"

function environment(provider: "AWS" | "GCP"): NodeJS.ProcessEnv {
  return {
    DEN_API_PUBLIC_URL: "https://api.example.test",
    [`DEN_MANAGED_DEPLOYMENT_${provider}_VERSION`]: "0.18.58",
    [`DEN_MANAGED_DEPLOYMENT_${provider}_TEMPLATE_URL`]: provider === "GCP" ? "https://storage.googleapis.com/test-release/tutorial.md?generation=1" : "https://releases.example.test/template.json",
    [`DEN_MANAGED_DEPLOYMENT_${provider}_BUNDLE_URL`]: provider === "GCP" ? "https://storage.googleapis.com/test-release/bundle.tar.gz?generation=2" : "https://releases.example.test/bundle.tar.gz",
    [`DEN_MANAGED_DEPLOYMENT_${provider}_BUNDLE_SHA256`]: "a".repeat(64),
  }
}
test("missing publication reports field names without exposing configuration values", () => {
  const result = releaseReadiness("aws", { DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL: "private-invalid-value" })
  assert.equal(result.available, false)
  assert.equal(result.reason, "not_configured")
  assert.ok(result.missingFields.includes("DEN_MANAGED_DEPLOYMENT_AWS_VERSION"))
  assert.ok(result.missingFields.includes("DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL"))
  assert.ok(!JSON.stringify(result).includes("private-invalid-value"))
})
for (const provider of ["aws", "gcp"] satisfies Array<"aws" | "gcp">) {
  test(`${provider} valid release is configured independently`, () => {
    const env = environment(provider === "aws" ? "AWS" : "GCP")
    assert.equal(releaseReadiness(provider, env).reason, "ready")
    assert.equal(releaseReadiness(provider === "aws" ? "gcp" : "aws", env).available, false)
  })
}
test("mutable GCP artifact URLs cannot advertise readiness", () => {
  const env = { ...environment("GCP"), DEN_MANAGED_DEPLOYMENT_GCP_BUNDLE_URL: "https://storage.googleapis.com/test-release/bundle.tar.gz" }
  assert.equal(releaseReadiness("gcp", env).available, false)
  assert.deepEqual(releaseReadiness("gcp", env).missingFields, ["DEN_MANAGED_DEPLOYMENT_GCP_BUNDLE_URL"])
})
test("invalid origin and embedded URL credentials never enable launch", () => {
  for (const origin of ["https://api.example.test/path", "https://user:password@api.example.test", "http://api.example.test"]) {
    const env = { ...environment("AWS"), DEN_API_PUBLIC_URL: origin }
    assert.equal(releaseReadiness("aws", env).reason, "invalid_configuration")
    assert.deepEqual(releaseReadiness("aws", env).missingFields, ["DEN_API_PUBLIC_URL"])
  }
  const env = { ...environment("AWS"), DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL: "https://secret@example.test/bundle" }
  assert.equal(releaseReadiness("aws", env).available, false)
})

function coordinates(provider: "aws" | "gcp", version = "0.18.65") {
  const base = provider === "aws"
    ? `https://test-release.s3.us-east-1.amazonaws.com/releases/aws/${version}/`
    : `https://storage.googleapis.com/test-release/releases/gcp/${version}/`
  const query = provider === "aws" ? "?versionId=immutable-version" : "?generation=123"
  return {
    version,
    templateUrl: base + (provider === "aws" ? "cloudformation.json" : "tutorial.md") + query,
    bundleUrl: base + "bundle.tar.gz" + query,
    bundleSha256: "b".repeat(64),
  }
}

for (const provider of ["aws", "gcp"] satisfies Array<"aws" | "gcp">) {
  const key = `DEN_MANAGED_DEPLOYMENT_${provider.toUpperCase()}_RELEASE`
  test(`${provider} atomic coordinates take precedence over every legacy field`, () => {
    const env = { ...environment(provider === "aws" ? "AWS" : "GCP"), [key]: JSON.stringify(coordinates(provider)) }
    const release = provider === "aws" ? awsRelease(env) : gcpRelease(env)
    assert.deepEqual(release, { ...coordinates(provider), apiOrigin: "https://api.example.test" })
    assert.equal(releaseReadiness(provider, env).version, "0.18.65")
  })
  test(`${provider} invalid present atomic config never silently resurrects the older pin`, () => {
    for (const value of ["", "null", "[]", "{", "{}", "private-invalid-value", JSON.stringify({ ...coordinates(provider), unexpected: true })]) {
      const env = { ...environment(provider === "aws" ? "AWS" : "GCP"), [key]: value }
      assert.equal(provider === "aws" ? awsRelease(env) : gcpRelease(env), null)
      assert.deepEqual(releaseReadiness(provider, env), {
        provider, available: false, version: null, reason: "invalid_configuration", missingFields: [key],
      })
      assert.ok(!JSON.stringify(releaseReadiness(provider, env)).includes("private-invalid-value"))
    }
  })
  test(`${provider} automatic config rejects mutable and duplicate object-version URLs`, () => {
    const c = coordinates(provider)
    for (const bundleUrl of [c.bundleUrl.split("?")[0], c.bundleUrl + (provider === "aws" ? "&versionId=second" : "&generation=2")]) {
      assert.equal(releaseReadiness(provider, { DEN_API_PUBLIC_URL: "https://api.example.test", [key]: JSON.stringify({ ...c, bundleUrl }) }).available, false)
    }
  })
  test(`${provider} automatic config admits production semver only`, () => {
    for (const version of ["latest", "dev", "0.18.65-rc.1", "v0.18.65", "00.18.65", "0.18.65+build"]) {
      assert.equal(releaseReadiness(provider, { DEN_API_PUBLIC_URL: "https://api.example.test", [key]: JSON.stringify({ ...coordinates(provider), version }) }).available, false)
    }
  })
  test(`${provider} promoted release cannot override the control-plane origin`, () => {
    assert.equal(releaseReadiness(provider, { DEN_API_PUBLIC_URL: "https://api.example.test", [key]: JSON.stringify({ ...coordinates(provider), apiOrigin: "https://elsewhere.example.test" }) }).available, false)
    assert.deepEqual(releaseReadiness(provider, { [key]: JSON.stringify(coordinates(provider)) }).missingFields, ["DEN_API_PUBLIC_URL"])
  })
}

test("invalid AWS object-version identities and signed expiry URLs fail closed", () => {
  const c = coordinates("aws")
  for (const bundleUrl of [
    c.bundleUrl.replace("immutable-version", "null"),
    c.bundleUrl.replace("immutable-version", ""),
    c.bundleUrl + "&X-Amz-Signature=temporary",
    c.bundleUrl.replace("test-release.s3.us-east-1.amazonaws.com", "mutable.example.test"),
  ]) {
    assert.equal(awsRelease({ DEN_API_PUBLIC_URL: "https://api.example.test", DEN_MANAGED_DEPLOYMENT_AWS_RELEASE: JSON.stringify({ ...c, bundleUrl }) }), null)
  }
})

test("promotion is provider-local and earlier approval coordinates stay unchanged", () => {
  const env = environment("AWS")
  const earlierApproval = awsRelease(env)
  env.DEN_MANAGED_DEPLOYMENT_AWS_RELEASE = JSON.stringify(coordinates("aws"))
  assert.equal(awsRelease(env)?.version, "0.18.65")
  assert.equal(earlierApproval?.version, "0.18.58")
  assert.equal(earlierApproval?.bundleUrl, "https://releases.example.test/bundle.tar.gz")
  assert.equal(gcpRelease(env), null)
  delete env.DEN_MANAGED_DEPLOYMENT_AWS_RELEASE
  assert.equal(awsRelease(env)?.version, "0.18.58")
})
