import assert from "node:assert/strict";
import { test } from "node:test";
import { openworkFeatureContributionSchema } from "@openwork/types/openwork-provider";
import { buildOpenworkProviderContributions, readEngineMcpDescriptors, type EngineMcpDescriptor } from "../src/opencode-plugins/openwork-provider-adapters.js";
import type { OpenWorkEngineMcpStatusClient } from "../src/opencode-plugins/openwork-extensions-preview-steering.js";

function mcpContribution(descriptor: EngineMcpDescriptor) {
  const contribution = buildOpenworkProviderContributions([], [descriptor])
    .find((item) => item.featureId === `mcp:${descriptor.name}`);
  assert.ok(contribution, `expected an mcp:${descriptor.name} contribution`);
  return contribution;
}

function statusClient(statuses: Record<string, string>): OpenWorkEngineMcpStatusClient {
  return {
    mcp: { status: async () => Object.fromEntries(Object.entries(statuses).map(([name, status]) => [name, { status }])) },
  };
}

test("a connected connector reports its status and the tool-name prefix its tools carry", () => {
  const contribution = mcpContribution({ name: "web-search", status: "connected" });
  assert.equal(contribution.status, "connected");
  assert.equal(contribution.toolNamePrefix, "web-search_");
  assert.deepEqual(contribution.affordances, []);
  assert.equal(contribution.guidance[0]?.loading, "eager");
  assert.match(contribution.guidance[0]?.description ?? "", /names starting "web-search_"/);
});

test("the prefix uses the engine's namespace rule for unsafe characters", () => {
  assert.equal(mcpContribution({ name: "my.server", status: "connected" }).toolNamePrefix, "my_server_");
});

test("a Code Mode connector points at its execute namespace instead of direct tool names", () => {
  const contribution = mcpContribution({ name: "tasks.app", status: "connected", toolAccess: "codemode" });
  assert.equal(contribution.status, "connected");
  assert.equal(contribution.toolNamespace, "tasks_app");
  assert.equal("toolNamePrefix" in contribution, false);
  assert.match(contribution.guidance[0]?.description ?? "", /inside execute as tools\["tasks_app"\]\.<tool>\(input\)/);
});

test("disconnected connectors report their real status and no prefix", () => {
  const failed = mcpContribution({ name: "crawler", status: "failed" });
  assert.equal(failed.status, "failed");
  assert.equal("toolNamePrefix" in failed, false);
  assert.match(failed.guidance[0]?.description ?? "", /Not connected \(status: failed\)/);
  assert.equal(failed.guidance[0]?.loading, "catalog");

  const needsAuth = mcpContribution({ name: "tasks-app", status: "needs_auth" });
  assert.equal(needsAuth.status, "needs_auth");
  assert.match(needsAuth.guidance[0]?.description ?? "", /Needs sign-in/);
});

test("openwork-cloud stays under connect and is not listed as an mcp feature", () => {
  const contributions = buildOpenworkProviderContributions([], [{ name: "openwork-cloud", status: "connected" }]);
  assert.equal(contributions.some((item) => item.featureId === "mcp:openwork-cloud"), false);
});

test("the contribution schema keeps the new fields and still accepts older payloads", () => {
  const parsed = openworkFeatureContributionSchema.parse(mcpContribution({ name: "web-search", status: "connected" }));
  assert.equal(parsed.status, "connected");
  assert.equal(parsed.toolNamePrefix, "web-search_");
  const legacy = { featureId: "mcp:old", provider: { id: "old", kind: "mcp" }, affordances: [], guidance: [] };
  assert.equal(openworkFeatureContributionSchema.parse(legacy).featureId, "mcp:old");
});

test("readEngineMcpDescriptors passes each server's engine status through", async () => {
  const descriptors = await readEngineMcpDescriptors(statusClient({ "web-search": "connected", crawler: "failed" }), "/workspace");
  assert.deepEqual(descriptors, [{ name: "web-search", status: "connected" }, { name: "crawler", status: "failed" }]);
});

test("readEngineMcpDescriptors returns nothing when the status read fails", async () => {
  const client: OpenWorkEngineMcpStatusClient = {
    mcp: { status: async () => { throw new Error("status unavailable"); } },
  };
  assert.deepEqual(await readEngineMcpDescriptors(client, undefined), []);
});

test("readEngineMcpDescriptors returns nothing without an engine client", async () => {
  assert.deepEqual(await readEngineMcpDescriptors(undefined, undefined), []);
});
