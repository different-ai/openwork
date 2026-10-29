import assert from "node:assert/strict"
import { test } from "node:test"
import { managedDeploymentLaunchSchema } from "@openwork/managed-deployments/schema"
import { catalogOperationAvailableToCapabilities } from "../src/mcp/catalog-availability.ts"

const managedPaths = [
  { method: "GET", path: "/v1/managed-deployments/configuration" },
  { method: "GET", path: "/v1/managed-deployments" },
  { method: "POST", path: "/v1/managed-deployments" },
  { method: "POST", path: "/v1/managed-deployments/{deploymentId}/launch" },
]

test("managed deployment capabilities stay hidden until the organization has the managed deployments rollout", () => {
  for (const generatedArtifactViewsEnabled of [true, false]) {
    for (const operation of managedPaths) {
      assert.equal(catalogOperationAvailableToCapabilities({ generatedArtifactViewsEnabled, managedDeploymentsEnabled: false }, operation), false)
      assert.equal(catalogOperationAvailableToCapabilities({ generatedArtifactViewsEnabled, managedDeploymentsEnabled: true }, operation), true)
    }
  }
  // Unrelated capabilities are unaffected by the deployment rollout.
  assert.equal(catalogOperationAvailableToCapabilities({ generatedArtifactViewsEnabled: true, managedDeploymentsEnabled: false }, { method: "GET", path: "/v1/plugins" }), true)
  assert.equal(catalogOperationAvailableToCapabilities({ generatedArtifactViewsEnabled: false, managedDeploymentsEnabled: true }, { method: "GET", path: "/v1/artifact-views/abc" }), false)
})

test("a launch handoff is either an approval link or a cloud shell command, never both or neither", () => {
  const base = {
    kind: "install", approvalUrl: null, command: null, expiresAt: "2026-10-14T00:00:00.000Z",
    deployment: {
      id: "00000000-0000-4000-8000-000000000001", name: "Test", provider: "aws",
      target: { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST" },
      domainName: "openwork.example.test", ownerEmail: "admin@example.test", size: "small", updateMode: "approval",
      createdAt: "2026-10-14T00:00:00.000Z", webUrl: "https://openwork.example.test", consoleUrl: "https://console.example.test",
      installedVersion: null, availableVersion: "0.18.58", updateAvailable: false,
      health: { state: "awaiting_report", reportedAt: null, version: null, checks: [] }, run: null,
    },
  }
  const link = { action: "open_link", url: "https://console.aws.amazon.com/cloudformation/home", command: null, instructions: "Approve." }
  const shell = { action: "run_in_cloud_shell", url: "https://console.cloud.google.com/?project=p&cloudshell=true", command: "( set -eu )", instructions: "Run." }
  assert.equal(managedDeploymentLaunchSchema.safeParse({ ...base, handoff: link }).success, true)
  assert.equal(managedDeploymentLaunchSchema.safeParse({ ...base, handoff: shell }).success, true)
  assert.equal(managedDeploymentLaunchSchema.safeParse({ ...base, handoff: { ...link, command: "rm -rf /" } }).success, false)
  assert.equal(managedDeploymentLaunchSchema.safeParse({ ...base, handoff: { ...shell, command: null } }).success, false)
  assert.equal(managedDeploymentLaunchSchema.safeParse({ ...base, handoff: { ...shell, url: "not a url" } }).success, false)
})
