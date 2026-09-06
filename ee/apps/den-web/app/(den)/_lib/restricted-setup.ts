import { applyRestrictedDesktopPolicy, normalizeDefaultDesktopPolicyValue } from "@openwork/types/den/desktop-policies";
import { parseDesktopPolicyList } from "../dashboard/_components/desktop-policy-data";
import { getErrorMessage, requestJson } from "./den-flow";
import { ORG_SCOPE_HEADER } from "./org-scope";

/** Apply the existing Restricted preset to this organization's default policy. */
export async function applyRestrictedSetup(orgId: string, expectedPolicyId?: string) {
  const headers = { [ORG_SCOPE_HEADER]: orgId };
  const result = await requestJson("/v1/desktop-policies", { headers }, 12000);
  if (!result.response.ok) throw new Error("We couldn’t finish Restricted setup. Your team is saved; try again.");
  const policy = parseDesktopPolicyList(result.payload).desktopPolicies.find((entry) => entry.isDefault);
  if (!policy || policy.policy.access) throw new Error("Your team’s default settings aren’t ready yet. Try again.");
  if (expectedPolicyId && policy.id !== expectedPolicyId) throw new Error("This setup belongs to another workspace. Switch to that workspace to continue.");
  const saved = await requestJson(`/v1/desktop-policies/${encodeURIComponent(policy.id)}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      policyName: policy.policyName,
      policy: { ...policy.policy, ...applyRestrictedDesktopPolicy(normalizeDefaultDesktopPolicyValue(policy.policy)) },
      isEnabled: true,
      priority: 0,
      memberIds: [], teamIds: [], roles: [],
    }),
  }, 12000);
  if (saved.response.status === 402) throw new Error("Restricted requires Enterprise. Your team is saved, but restrictions haven’t been applied.");
  if (!saved.response.ok) throw new Error(getErrorMessage(saved.payload, "We couldn’t apply Restricted settings. Try again."));
}
