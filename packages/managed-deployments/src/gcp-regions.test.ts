import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { cloudShellCommand, type GcpLaunch } from "@openwork/managed-deployments/gcp"
import { gcpRegionSchema, gcpTargetSchema, managedDeploymentInputSchema } from "@openwork/managed-deployments/schema"

const hongKong = { projectId: "fixture-project", projectNumber: "123456789012", region: "asia-east2", dnsZoneName: "fixture-zone" }
const launch: GcpLaunch = {
  deploymentId: "00000000-0000-4000-8000-000000000001", runId: "00000000-0000-4000-8000-000000000002", challenge: "a".repeat(64),
  target: gcpTargetSchema.parse(hongKong), domainName: "openwork.example.test", ownerEmail: "admin@example.test", size: "small",
  release: {
    templateUrl: "https://storage.googleapis.com/fixture/template.json?generation=1",
    bundleUrl: "https://storage.googleapis.com/fixture/bundle.tar.gz?generation=2",
    bundleSha256: "b".repeat(64), version: "1.0.0", apiOrigin: "https://api.example.test",
  },
}

test("Hong Kong is one of the Google Cloud regions a deployment can choose", () => {
  assert.ok(gcpRegionSchema.options.includes("asia-east2"))
  const input = managedDeploymentInputSchema.parse({
    provider: "gcp", name: "Fixture deployment", domainName: "openwork.example.test", ownerEmail: "owner@example.test", target: hongKong,
  })
  assert.equal(input.provider, "gcp")
  assert.deepEqual(input.target, hongKong)
})

test("the Cloud Shell command hands the installer the Hong Kong region", () => {
  const encoded = cloudShellCommand(launch).match(/--config-base64 '([A-Za-z0-9+/=]+)'/)?.[1]
  assert.ok(encoded)
  const config = z.object({ target: gcpTargetSchema }).parse(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")))
  assert.deepEqual(config.target, hongKong)
})

test("a zone or another cloud's region is not a Google Cloud region", () => {
  for (const region of ["asia-east2-a", "ap-east-1", "hong-kong"]) {
    assert.equal(gcpTargetSchema.safeParse({ ...hongKong, region }).success, false, region)
  }
})
