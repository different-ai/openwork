"use client";

import { useMemo } from "react";
import {
  createDesktopPolicy,
  updateDesktopPolicy,
  useOrgDesktopPolicies,
  type DenDesktopPolicy,
  type DenDesktopPolicyRole,
} from "./desktop-policy-data";

/**
 * "Who can use models": the org default desktop policy's
 * `allowCustomProviders` and `allowZenModel`, plus the "Admins may add
 * providers" exception policy. Shared by AI Gateway and the legacy
 * Bring Your Own Keys page so both edit the same rule the same way.
 */
export type ModelAccessMode = "open" | "managed";

export type ModelAccessValue = {
  mode: ModelAccessMode;
  adminException: boolean;
  zenAllowed: boolean;
};

export const ADMIN_EXCEPTION_POLICY_NAME = "Admins may add providers";
const ADMIN_EXCEPTION_ROLES: DenDesktopPolicyRole[] = ["owner", "admin"];

function getPolicyMemberIds(policy: DenDesktopPolicy) {
  return policy.assignments.flatMap((assignment) => (assignment.orgMemberId ? [assignment.orgMemberId] : []));
}

function getPolicyTeamIds(policy: DenDesktopPolicy) {
  return policy.assignments.flatMap((assignment) => (assignment.teamId ? [assignment.teamId] : []));
}

function getPolicyRoles(policy: DenDesktopPolicy) {
  return policy.roles.length > 0
    ? policy.roles
    : policy.assignments.flatMap((assignment) => (assignment.role ? [assignment.role] : []));
}

export function readModelAccess(defaultPolicy: DenDesktopPolicy | null, adminExceptionPolicies: DenDesktopPolicy[]): ModelAccessValue {
  const open = defaultPolicy?.policy.allowCustomProviders !== false;
  return {
    mode: open ? "open" : "managed",
    adminException: open ? true : adminExceptionPolicies.some((policy) => policy.isEnabled),
    zenAllowed: defaultPolicy?.policy.allowZenModel !== false,
  };
}

export function useModelAccessPolicy(orgId: string | null) {
  const { desktopPolicies, busy, error, reloadPolicies } = useOrgDesktopPolicies(orgId);

  const defaultPolicy = useMemo(
    () => desktopPolicies.find((policy) => policy.isDefault) ?? null,
    [desktopPolicies],
  );
  const adminExceptionPolicies = useMemo(
    () => desktopPolicies.filter((policy) => !policy.isDefault && policy.policyName === ADMIN_EXCEPTION_POLICY_NAME),
    [desktopPolicies],
  );
  const saved = useMemo(() => readModelAccess(defaultPolicy, adminExceptionPolicies), [defaultPolicy, adminExceptionPolicies]);

  async function updateDefaultPolicy(allowCustomProviders: boolean, allowZenModel: boolean) {
    if (!defaultPolicy) throw new Error("Default desktop policy not found.");
    await updateDesktopPolicy(defaultPolicy.id, {
      policyName: defaultPolicy.policyName,
      policy: { ...defaultPolicy.policy, allowCustomProviders, allowZenModel },
      priority: 0,
      isEnabled: true,
      memberIds: [],
      teamIds: [],
      roles: [],
    });
  }

  async function disablePolicy(policy: DenDesktopPolicy) {
    if (!policy.isEnabled) return;
    await updateDesktopPolicy(policy.id, {
      policyName: policy.policyName,
      policy: policy.policy,
      priority: policy.priority,
      isEnabled: false,
      memberIds: getPolicyMemberIds(policy),
      teamIds: getPolicyTeamIds(policy),
      roles: getPolicyRoles(policy),
    });
  }

  async function ensureAdminExceptionPolicy() {
    const primary = adminExceptionPolicies[0] ?? null;
    if (primary) {
      await updateDesktopPolicy(primary.id, {
        policyName: ADMIN_EXCEPTION_POLICY_NAME,
        policy: { ...primary.policy, allowCustomProviders: true },
        priority: primary.priority,
        isEnabled: true,
        memberIds: [],
        teamIds: [],
        roles: ADMIN_EXCEPTION_ROLES,
      });
    } else {
      await createDesktopPolicy({
        policyName: ADMIN_EXCEPTION_POLICY_NAME,
        policy: { allowCustomProviders: true },
        priority: 0,
        isEnabled: true,
        memberIds: [],
        teamIds: [],
        roles: ADMIN_EXCEPTION_ROLES,
      });
    }
    for (const policy of adminExceptionPolicies.slice(1)) await disablePolicy(policy);
  }

  /** Writes the rule. Callers wrap this in `runReauthableAction`. */
  async function save(next: ModelAccessValue) {
    if (next.mode === "managed") {
      await updateDefaultPolicy(false, next.zenAllowed);
      if (next.adminException) await ensureAdminExceptionPolicy();
      else for (const policy of adminExceptionPolicies) await disablePolicy(policy);
    } else {
      await updateDefaultPolicy(true, next.zenAllowed);
      for (const policy of adminExceptionPolicies) await disablePolicy(policy);
    }
    await reloadPolicies();
  }

  return { saved, defaultPolicy, busy, error, save };
}
