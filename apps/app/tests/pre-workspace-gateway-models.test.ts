import { expect, test } from "bun:test";

import type { GatewayUsableModel } from "@openwork/types/den/gateway";
import type { DenOrgUsableGatewayProvider } from "../src/app/lib/den";
import { assignedGatewayModelOptions } from "../src/react-app/domains/connections/provider-auth/assigned-model-options";

function model(selection: number): GatewayUsableModel {
  const suffix = selection.toString().padStart(26, "0");
  const id = `gwm_${suffix}_${suffix}_${suffix}`;
  return {
    id,
    name: "Assigned model",
    config: { id },
    upstreamModelId: "upstream-model",
    modelGroupId: `gmg_${suffix}`,
    modelGroupName: "Assigned group",
    credentialSetId: `gcs_${suffix}`,
    credentialSetName: "Member account",
  };
}

function provider(overrides: Partial<DenOrgUsableGatewayProvider> = {}): DenOrgUsableGatewayProvider {
  return {
    id: "ipr_00000000000000000000000001",
    providerId: "catalog-provider",
    name: "Organization Gateway",
    source: "openwork_gateway",
    credentialStatus: "ready",
    updatedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    authorizationRequests: [],
    ...overrides,
  };
}

function authorizationRequest(pending: GatewayUsableModel) {
  return {
    credentialSetId: pending.credentialSetId,
    name: pending.credentialSetName,
    authUrl: "https://example.com/sign-in",
    models: [pending],
  };
}

test("mixed ready and pending assignments offer only ready models", () => {
  const ready = model(1);
  const pending = model(2);
  const mixed = provider({
    credentialStatus: "member_auth_required",
    models: [ready],
    authorizationRequests: [authorizationRequest(pending)],
  });

  expect(assignedGatewayModelOptions([mixed])).toEqual([{
    providerID: mixed.id,
    modelID: ready.id,
    title: ready.name,
    behaviorTitle: "Reasoning",
    behaviorLabel: "Default",
    behaviorDescription: "",
    behaviorValue: null,
    isFree: false,
    source: "gateway",
  }]);
});

test("pending-only assignments do not offer selectable models", () => {
  const pendingOnly = provider({
    credentialStatus: "member_auth_required",
    authorizationRequests: [authorizationRequest(model(2))],
  });

  expect(assignedGatewayModelOptions([pendingOnly])).toEqual([]);
});

test("Gateway provider identities and full model aliases are preserved unchanged", () => {
  const first = model(1);
  const second = model(2);
  const assigned = provider({ models: [first, second] });

  expect(assignedGatewayModelOptions([assigned]).map((option) => ({
    providerID: option.providerID,
    modelID: option.modelID,
  }))).toEqual([
    { providerID: assigned.id, modelID: first.id },
    { providerID: assigned.id, modelID: second.id },
  ]);
});

test("empty Gateway metadata offers no selectable models", () => {
  expect(assignedGatewayModelOptions([])).toEqual([]);
  expect(assignedGatewayModelOptions([provider()])).toEqual([]);
});
