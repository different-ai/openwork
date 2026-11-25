import assert from "node:assert/strict";
import { test } from "node:test";
import type { DenDesktopPolicy } from "./desktop-policy-data";
import { ADMIN_EXCEPTION_POLICY_NAME, readModelAccessState, saveModelAccess } from "./model-access-policy";

const policy = (overrides: Partial<DenDesktopPolicy>): DenDesktopPolicy => ({
  id: "dp_default", organizationId: "org_test", policyName: "Default", isDefault: true, isEnabled: true, priority: 0, policy: {},
  createdByOrgMemberId: "om_owner", createdAt: null, updatedAt: null, roles: [], assignments: [], ...overrides,
});

function recorder() {
  const writes: Array<{ kind: "update" | "create"; policy: Record<string, unknown> }> = [];
  return {
    writes,
    api: {
      updateDesktopPolicy: async (_id: string, input: { policy: Record<string, unknown> }) => { writes.push({ kind: "update", policy: input.policy }); },
      createDesktopPolicy: async (input: { policy: Record<string, unknown> }) => { writes.push({ kind: "create", policy: input.policy }); },
    },
  };
}

test("local models read as on unless turned off, and inherit Only models you provide when never saved", () => {
  assert.equal(readModelAccessState([policy({ policy: {} })]).localAllowed, true);
  assert.equal(readModelAccessState([policy({ policy: { allowCustomProviders: false } })]).localAllowed, false);
  assert.equal(readModelAccessState([policy({ policy: { allowCustomProviders: true, allowLocalModels: false } })]).localAllowed, false);
  assert.equal(readModelAccessState([policy({ policy: { allowCustomProviders: false, allowLocalModels: true } })]).localAllowed, true);
});

test("saving writes the switch to the default policy and the admin exception, never re-opening what the owner turned off", async () => {
  const { writes, api } = recorder();
  const state = readModelAccessState([policy({ policy: { allowCustomProviders: true } })]);
  await saveModelAccess(state, { mode: "managed", adminException: true, zenAllowed: true, localAllowed: false }, api);
  assert.deepEqual(writes.map((write) => [write.kind, write.policy.allowCustomProviders, write.policy.allowLocalModels]), [
    ["update", false, false],
    ["create", true, false],
  ]);
});

test("opening personal keys preserves the explicit local-model choice", async () => {
  const { writes, api } = recorder();
  const state = readModelAccessState([
    policy({ policy: { allowCustomProviders: true, allowLocalModels: false } }),
    policy({ id: "dp_admins", isDefault: false, policyName: ADMIN_EXCEPTION_POLICY_NAME, policy: { allowCustomProviders: true } }),
  ]);
  await saveModelAccess(state, { mode: "open", adminException: true, zenAllowed: true, localAllowed: state.localAllowed }, api);
  assert.equal(writes[0]?.policy.allowLocalModels, false, "the default keeps what was stored");
  assert.ok(!writes.some((write) => write.kind === "create"));
});
