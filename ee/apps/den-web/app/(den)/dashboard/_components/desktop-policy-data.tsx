"use client";

import { useEffect, useState } from "react";
import {
  desktopPolicyKeys,
  normalizeDesktopPolicyDocument,
  type DesktopPolicyDefinition,
  type DesktopPolicyDocument,
  type DesktopPolicyDocumentWrite,
} from "@openwork/types/den/desktop-policies";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";

export type DenDesktopPolicyRole = "owner" | "admin" | "member";

export type DenDesktopPolicyAssignment = {
  id: string;
  orgMemberId: string | null;
  teamId: string | null;
  role: DenDesktopPolicyRole | null;
  createdAt: string | null;
};

export type DenDesktopPolicy = {
  id: string;
  organizationId: string;
  policyName: string;
  isDefault: boolean;
  isEnabled: boolean;
  priority: number;
  policy: DesktopPolicyDocument;
  createdByOrgMemberId: string;
  createdAt: string | null;
  updatedAt: string | null;
  roles: DenDesktopPolicyRole[];
  assignments: DenDesktopPolicyAssignment[];
};

export type DesktopPolicyPayload = {
  policyName: string;
  policy: DesktopPolicyDocumentWrite;
  priority?: number;
  isEnabled?: boolean;
  memberIds?: string[];
  teamIds?: string[];
  roles?: DenDesktopPolicyRole[];
};

export const DESKTOP_POLICY_ENTERPRISE_PLAN_ERROR = "Desktop policies require an Enterprise plan";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asIsoString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRole(value: unknown): DenDesktopPolicyRole | null {
  if (value === "owner" || value === "admin" || value === "member") return value;
  return null;
}

function asRoleList(value: unknown): DenDesktopPolicyRole[] {
  if (!Array.isArray(value)) return [];
  return value.map(asRole).filter((entry): entry is DenDesktopPolicyRole => entry !== null);
}

function uniqueRoles(values: DenDesktopPolicyRole[]) {
  return [...new Set(values)];
}

function isDesktopPolicyKey(value: string | null): value is DesktopPolicyDefinition["id"] {
  return value !== null && desktopPolicyKeys.includes(value as DesktopPolicyDefinition["id"]);
}

function asPolicy(value: unknown): DesktopPolicyDocument {
  return normalizeDesktopPolicyDocument(value);
}

function asAssignment(value: unknown): DenDesktopPolicyAssignment | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (!id) return null;
  return {
    id,
    orgMemberId: asString(value.orgMemberId),
    teamId: asString(value.teamId),
    role: asRole(value.role),
    createdAt: asIsoString(value.createdAt),
  };
}

function asDefinition(value: unknown): DesktopPolicyDefinition | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const name = asString(value.name);
  const description = asString(value.description);
  const userNotice = asString(value.userNotice);
  if (!isDesktopPolicyKey(id) || !name || !description || !userNotice) {
    return null;
  }
  return {
    id,
    name,
    description,
    userNotice,
    defaultValue: value.defaultValue === true,
  };
}

function asDesktopPolicy(value: unknown): DenDesktopPolicy | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const organizationId = asString(value.organizationId);
  const policyName = asString(value.policyName);
  const createdByOrgMemberId = asString(value.createdByOrgMemberId);
  if (!id || !organizationId || !policyName || !createdByOrgMemberId) return null;
  const assignments = Array.isArray(value.assignments)
    ? value.assignments.map(asAssignment).filter((entry): entry is DenDesktopPolicyAssignment => entry !== null)
    : [];
  const roles = asRoleList(value.roles);
  return {
    id,
    organizationId,
    policyName,
    isDefault: value.isDefault === true,
    isEnabled: value.isEnabled === true,
    priority: typeof value.priority === "number" && Number.isInteger(value.priority) ? value.priority : 0,
    policy: asPolicy(value.policy),
    createdByOrgMemberId,
    createdAt: asIsoString(value.createdAt),
    updatedAt: asIsoString(value.updatedAt),
    roles: roles.length > 0
      ? uniqueRoles(roles)
      : uniqueRoles(assignments.flatMap((assignment) => (assignment.role ? [assignment.role] : []))),
    assignments,
  };
}

function parseDesktopPolicyList(payload: unknown) {
  if (!isRecord(payload)) return { definitions: [], desktopPolicies: [] };
  return {
    definitions: Array.isArray(payload.definitions)
      ? payload.definitions.map(asDefinition).filter((entry): entry is DesktopPolicyDefinition => entry !== null)
      : [],
    desktopPolicies: Array.isArray(payload.desktopPolicies)
      ? payload.desktopPolicies.map(asDesktopPolicy).filter((entry): entry is DenDesktopPolicy => entry !== null)
      : [],
  };
}

export function useOrgDesktopPolicies(orgId: string | null) {
  const [definitions, setDefinitions] = useState<DesktopPolicyDefinition[]>([]);
  const [desktopPolicies, setDesktopPolicies] = useState<DenDesktopPolicy[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reloadPolicies() {
    if (!orgId) {
      setDefinitions([]);
      setDesktopPolicies([]);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { response, payload } = await requestJson("/v1/desktop-policies", { method: "GET" }, 12000);
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load desktop policies (${response.status}).`));
      }
      const parsed = parseDesktopPolicyList(payload);
      setDefinitions(parsed.definitions);
      setDesktopPolicies(parsed.desktopPolicies);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to load desktop policies.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void reloadPolicies();
  }, [orgId]);

  return { definitions, desktopPolicies, busy, error, reloadPolicies };
}

export async function createDesktopPolicy(input: DesktopPolicyPayload) {
  const { response, payload } = await requestJson("/v1/desktop-policies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }, 12000);
  if (!response.ok) {
    if (response.status === 402) throw new Error(DESKTOP_POLICY_ENTERPRISE_PLAN_ERROR);
    throw getRequestError(payload, response, `Failed to create desktop policy (${response.status}).`);
  }
}

export async function updateDesktopPolicy(policyId: string, input: DesktopPolicyPayload) {
  const { response, payload } = await requestJson(`/v1/desktop-policies/${encodeURIComponent(policyId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }, 12000);
  if (!response.ok) {
    if (response.status === 402) throw new Error(DESKTOP_POLICY_ENTERPRISE_PLAN_ERROR);
    throw getRequestError(payload, response, `Failed to update desktop policy (${response.status}).`);
  }
}

export async function deleteDesktopPolicy(policyId: string) {
  const { response, payload } = await requestJson(`/v1/desktop-policies/${encodeURIComponent(policyId)}`, {
    method: "DELETE",
  }, 12000);
  if (!response.ok) {
    throw getRequestError(payload, response, `Failed to delete desktop policy (${response.status}).`);
  }
}
