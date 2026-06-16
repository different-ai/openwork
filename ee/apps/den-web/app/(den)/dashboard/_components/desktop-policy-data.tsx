"use client";

import { useEffect, useState } from "react";
import {
  desktopPolicyKeys,
  normalizeDesktopPolicyValue,
  type DesktopPolicyDefinition,
  type DesktopPolicyValue,
} from "@openwork/types/den/desktop-policies";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";

export type DenDesktopPolicyAssignment = {
  id: string;
  orgMemberId: string | null;
  teamId: string | null;
  createdAt: string | null;
};

export type DenDesktopPolicy = {
  id: string;
  organizationId: string;
  policyName: string;
  isDefault: boolean;
  isEnabled: boolean;
  policy: DesktopPolicyValue;
  createdByOrgMemberId: string;
  createdAt: string | null;
  updatedAt: string | null;
  assignments: DenDesktopPolicyAssignment[];
};

export type DesktopPolicyPayload = {
  policyName: string;
  policy: DesktopPolicyValue;
  isEnabled?: boolean;
  memberIds?: string[];
  teamIds?: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asIsoString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isDesktopPolicyKey(value: string | null): value is DesktopPolicyDefinition["id"] {
  return value !== null && desktopPolicyKeys.includes(value as DesktopPolicyDefinition["id"]);
}

function asPolicy(value: unknown): DesktopPolicyValue {
  return normalizeDesktopPolicyValue(value);
}

function asAssignment(value: unknown): DenDesktopPolicyAssignment | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (!id) return null;
  return {
    id,
    orgMemberId: asString(value.orgMemberId),
    teamId: asString(value.teamId),
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
  return {
    id,
    organizationId,
    policyName,
    isDefault: value.isDefault === true,
    isEnabled: value.isEnabled === true,
    policy: asPolicy(value.policy),
    createdByOrgMemberId,
    createdAt: asIsoString(value.createdAt),
    updatedAt: asIsoString(value.updatedAt),
    assignments: Array.isArray(value.assignments)
      ? value.assignments.map(asAssignment).filter((entry): entry is DenDesktopPolicyAssignment => entry !== null)
      : [],
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
