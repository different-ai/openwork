import assert from "node:assert/strict";
import { test } from "node:test";
import type { DenOrgContext } from "../../_lib/den-org";
import { myAgentAvailable } from "./my-agent-availability";

function context(overrides: Partial<Pick<DenOrgContext, "capabilities" | "features">>): DenOrgContext {
  return {
    organization: { id: "org_1", name: "Acme", slug: "acme" },
    capabilities: { auditLogs: false, installLinks: false, mcpConnections: false, appMcpServers: false, workflows: true, openworkWeb: false, cloud: false, workbot: true },
    features: { workbotProactive: true, workbotAgentLibrary: true } as DenOrgContext["features"],
    ...overrides,
  } as unknown as DenOrgContext;
}

test("My bot is available only when Workbot capability and both rollouts are on", () => {
  assert.equal(myAgentAvailable(context({})), true);
  assert.equal(myAgentAvailable(null), false);
  assert.equal(myAgentAvailable(undefined), false);
});

test("missing Workbot capability hides My bot even when both rollouts are on", () => {
  assert.equal(
    myAgentAvailable(context({ capabilities: { auditLogs: false, installLinks: false, mcpConnections: false, appMcpServers: false, workflows: true, openworkWeb: false, cloud: false, workbot: false } })),
    false,
  );
});

test("turning either rollout off hides My bot even when Workbot is advertised", () => {
  assert.equal(
    myAgentAvailable(context({ features: { workbotProactive: false, workbotAgentLibrary: true } as DenOrgContext["features"] })),
    false,
  );
  assert.equal(
    myAgentAvailable(context({ features: { workbotProactive: true, workbotAgentLibrary: false } as DenOrgContext["features"] })),
    false,
  );
});

test("missing rollout reports from an older server default off, hiding My bot", () => {
  assert.equal(
    myAgentAvailable(context({ features: {} as DenOrgContext["features"] })),
    false,
  );
});