import assert from "node:assert/strict";
import { test } from "node:test";
import { mapFeatures } from "@openwork/features";
import type { DenOrgContext } from "../../_lib/den-org";
import { myAgentAvailable } from "./my-agent-availability";

function context(overrides: Partial<Pick<DenOrgContext, "capabilities" | "features">>): DenOrgContext {
  return {
    organization: { id: "org_1", name: "Acme", slug: "acme" },
    capabilities: { auditLogs: false, installLinks: false, mcpConnections: false, appMcpServers: false, workflows: true, openworkWeb: false, cloud: false, workbot: true },
    features: mapFeatures(() => false),
    ...overrides,
  } as unknown as DenOrgContext;
}

test("My bot is available when Workbot capability is on", () => {
  assert.equal(myAgentAvailable(context({})), true);
  assert.equal(myAgentAvailable(null), false);
  assert.equal(myAgentAvailable(undefined), false);
});

test("missing Workbot capability hides My bot regardless of rollout data", () => {
  assert.equal(
    myAgentAvailable(context({ capabilities: { auditLogs: false, installLinks: false, mcpConnections: false, appMcpServers: false, workflows: true, openworkWeb: false, cloud: false, workbot: false } })),
    false,
  );
});
