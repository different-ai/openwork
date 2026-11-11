import {
  createDesktopPolicy,
  updateDesktopPolicy,
  type DenDesktopPolicy,
  type DesktopPolicyPayload,
  type DenDesktopPolicyRole,
} from "./desktop-policy-data";

export type ModelAccessMode = "open" | "managed";

export const ADMIN_EXCEPTION_POLICY_NAME = "Admins may add providers";
const ADMIN_EXCEPTION_ROLES: DenDesktopPolicyRole[] = ["owner", "admin"];

export type ModelAccessState = {
  defaultPolicy: DenDesktopPolicy | null;
  adminExceptionPolicies: DenDesktopPolicy[];
  mode: ModelAccessMode;
  adminException: boolean;
  zenAllowed: boolean;
  /** Ollama and LM Studio. Unset keys inherit the provider setting, as Den does. */
  localAllowed: boolean;
};

/** Reads the org's "who can use models" answer out of its desktop policies. */
export function readModelAccessState(policies: DenDesktopPolicy[]): ModelAccessState {
  const defaultPolicy = policies.find((policy) => policy.isDefault) ?? null;
  const adminExceptionPolicies = policies.filter(
    (policy) => !policy.isDefault && policy.policyName === ADMIN_EXCEPTION_POLICY_NAME,
  );
  const open = defaultPolicy?.policy.allowCustomProviders !== false;
  return {
    defaultPolicy,
    adminExceptionPolicies,
    mode: open ? "open" : "managed",
    adminException: open ? true : adminExceptionPolicies.some((policy) => policy.isEnabled),
    zenAllowed: defaultPolicy?.policy.allowZenModel !== false,
    localAllowed: (defaultPolicy?.policy.allowLocalModels ?? defaultPolicy?.policy.allowCustomProviders) !== false,
  };
}

function assignmentIds(policy: DenDesktopPolicy, key: "orgMemberId" | "teamId"): string[] {
  return policy.assignments.flatMap((assignment) => {
    const id = assignment[key];
    return id ? [id] : [];
  });
}

type DesktopPolicyWrites = {
  updateDesktopPolicy: (policyId: string, input: DesktopPolicyPayload) => Promise<unknown>;
  createDesktopPolicy: (input: DesktopPolicyPayload) => Promise<unknown>;
};
const desktopPolicyWrites: DesktopPolicyWrites = { updateDesktopPolicy, createDesktopPolicy };

async function disablePolicy(policy: DenDesktopPolicy, writes: DesktopPolicyWrites) {
  if (!policy.isEnabled) return;
  await writes.updateDesktopPolicy(policy.id, {
    policyName: policy.policyName,
    policy: policy.policy,
    priority: policy.priority,
    isEnabled: false,
    memberIds: assignmentIds(policy, "orgMemberId"),
    teamIds: assignmentIds(policy, "teamId"),
    roles: policy.roles.length
      ? policy.roles
      : policy.assignments.flatMap((assignment) => (assignment.role ? [assignment.role] : [])),
  });
}

/** Writes the default policy and the admin-exception policy so they agree with the chosen mode. */
export async function saveModelAccess(
  state: Pick<ModelAccessState, "defaultPolicy" | "adminExceptionPolicies">,
  next: { mode: ModelAccessMode; adminException: boolean; zenAllowed: boolean; localAllowed?: boolean },
  writes: DesktopPolicyWrites = desktopPolicyWrites,
) {
  // Without the localModelsPolicy rollout `localAllowed` is omitted: leave the
  // stored key alone so local models keep following the provider setting.
  const local = next.localAllowed === undefined ? {} : { allowLocalModels: next.localAllowed };
  const { defaultPolicy, adminExceptionPolicies } = state;
  if (!defaultPolicy) throw new Error("Default desktop policy not found.");
  const managed = next.mode === "managed";
  await writes.updateDesktopPolicy(defaultPolicy.id, {
    policyName: defaultPolicy.policyName,
    policy: {
      ...defaultPolicy.policy,
      allowCustomProviders: !managed,
      allowZenModel: managed ? next.zenAllowed : true,
      ...local,
    },
    priority: 0,
    isEnabled: true,
    memberIds: [],
    teamIds: [],
    roles: [],
  });
  const [primary, ...rest] = adminExceptionPolicies;
  if (managed && next.adminException) {
    if (primary) {
      await writes.updateDesktopPolicy(primary.id, {
        policyName: ADMIN_EXCEPTION_POLICY_NAME,
        // The admin exception never re-opens local models the organization turned off.
        policy: { ...primary.policy, allowCustomProviders: true, ...local },
        priority: primary.priority,
        isEnabled: true,
        memberIds: [],
        teamIds: [],
        roles: ADMIN_EXCEPTION_ROLES,
      });
    } else {
      await writes.createDesktopPolicy({
        policyName: ADMIN_EXCEPTION_POLICY_NAME,
        policy: { allowCustomProviders: true, ...local },
        priority: 0,
        isEnabled: true,
        memberIds: [],
        teamIds: [],
        roles: ADMIN_EXCEPTION_ROLES,
      });
    }
    for (const policy of rest) await disablePolicy(policy, writes);
    return;
  }
  for (const policy of adminExceptionPolicies) await disablePolicy(policy, writes);
}
