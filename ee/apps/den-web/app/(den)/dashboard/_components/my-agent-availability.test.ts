import assert from "node:assert/strict";
import { test } from "node:test";
import type { DenOrgContext } from "../../_lib/den-org";
import { myAgentAvailable } from "./my-agent-availability";

function context(overrides: Partial<Pick<DenOrgContext, "capabilities" | "features">>): DenOrgContext {
  return {
    organization: { id: "org_1", name: "Acme", slug: "acme" },
    capabilities: { auditLogs: false, installLinks: false, mcpConnections: false, appMcpServers: false, workflows: true, openworkWeb: false, cloud: false, workbot: true },
    features: { workbotProactive: true } as DenOrgContext["features"],
    ...overrides,
  } as unknown as DenOrgContext;
}

test("My bot is available only when Workbot capability and the Your agent rollout is on", () => {
  assert.equal(myAgentAvailable(context({})), true);
  assert.equal(myAgentAvailable(null), false);
  assert.equal(myAgentAvailable(undefined), false);
});

test("missing Workbot capability hides My bot even when Your agent is on", () => {
  assert.equal(
    myAgentAvailable(context({ capabilities: { auditLogs: false, installLinks: false, mcpConnections: false, appMcpServers: false, workflows: true, openworkWeb: false, cloud: false, workbot: false } })),
    false,
  );
});

test("turning the Your agent rollout off hides My bot even when Workbot is advertised", () => {
  assert.equal(
    myAgentAvailable(context({ features: { workbotProactive: false } as DenOrgContext["features"] })),
    false,
  );
});

test("missing rollout reports from an older server default off, hiding My bot", () => {
  assert.equal(
    myAgentAvailable(context({ features: {} as DenOrgContext["features"] })),
    false,
  );
});