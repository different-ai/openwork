// Regression spec for a field-reported "stale Enabled state" defect
// (desktop 0.18.41/0.18.42):
// after an org-managed cloud provider (per-member LiteLLM key) was
// disconnected, the composer model picker was forced open with "The model you
// were using is no longer available…" yet the very same provider was still
// listed with all of its models and a green "Enabled" pill.
//
// Cause: the picker merged grant-based Den options (`assignedModelOptions`)
// into the engine catalog regardless of credential state, and the desktop
// parser dropped Den's per-member `hasMyCredential` flag entirely.
//
// The spec drives the REAL renderer pipeline (the exact exported functions
// `useModelPicker` composes) with a deterministic witness of the
// post-disconnect state and asserts both halves of the contract:
//   - the availability gate (which forces the picker open) declares the
//     provider's models unavailable, AND
//   - the picker option list offers none of that provider's models,
//   - while a granted provider whose credential is still active keeps its
//     models before the engine has connected it (the pre-workspace window).
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import type { DenOrgLlmProvider } from "../../apps/app/src/app/lib/den";
import type { ModelOption } from "../../apps/app/src/app/types";
import {
  assignedModelOptions,
  filterCloudManagedModelOptions,
  mergeModelOptions,
} from "../../apps/app/src/react-app/domains/connections/provider-auth/assigned-model-options";
import { filterEntitledModelOptions } from "../../apps/app/src/react-app/domains/connections/provider-auth/provider-policy";
import { computeModelAvailability } from "../../apps/app/src/react-app/domains/session/surface/model-availability";
import { getConnectedProviderItems } from "../../apps/app/src/react-app/infra/provider-list-query";

const PROVIDER_KEY = "lpr_acme_litellm_eval";
const MODEL_COUNT = 12;

function grantedProvider(hasMyCredential: boolean): DenOrgLlmProvider {
  return {
    id: PROVIDER_KEY,
    source: "custom",
    providerId: "acme-litellm",
    name: "Acme LiteLLM",
    providerConfig: {
      npm: "@ai-sdk/openai-compatible",
      api: "https://litellm.acme.example/v1",
      env: ["LITELLM_API_KEY"],
    },
    // Per-member providers never carry a shared org key.
    hasApiKey: false,
    hasMyCredential,
    models: Array.from({ length: MODEL_COUNT }, (_, index) => ({
      id: `litellm-model-${String(index + 1).padStart(2, "0")}`,
      name: `LiteLLM Model ${index + 1}`,
      config: {},
      createdAt: null,
    })),
    createdAt: null,
    updatedAt: null,
  };
}

/**
 * The Den grant catalog entry for "Acme LiteLLM" as the session route
 * holds it in `cloudOrgProviders` AFTER the member deleted their per-member
 * credential (DELETE /v1/llm-providers/:id/my-credential): the grant remains,
 * the credential is gone, all 12 models still listed.
 */
const grantedDisconnectedProvider = grantedProvider(false);

/**
 * The workspace engine's provider list AFTER the disconnect settled: the
 * server-side cloud provider sync skipped the provider (needs_key), removed
 * the runtime `lpr_*` block, and the engine reloaded. Nothing is connected —
 * this is the catalog the availability gate trusts.
 */
const engineListAfterDisconnect: ProviderListResponse = {
  all: [],
  connected: [],
  default: {},
};

const noRestrictions = () => false;

const currentModel = {
  providerID: PROVIDER_KEY,
  modelID: "litellm-model-01",
};

/** Replicates the option pipeline of `useModelPicker` (use-model-picker.ts). */
function buildPickerOptions(input: {
  engineList: ProviderListResponse;
  grantCatalog: readonly DenOrgLlmProvider[];
  cloudProvidersEnabled: boolean;
  restrictToCloud: boolean;
}): ModelOption[] {
  const engineOptions: ModelOption[] = getConnectedProviderItems(input.engineList).flatMap(
    (provider) =>
      Object.entries(provider.models).map(([modelID, model]) => ({
        providerID: provider.id,
        modelID,
        title: model.name || modelID,
        description: provider.name,
        behaviorTitle: "",
        behaviorLabel: "",
        behaviorDescription: "",
        behaviorValue: null,
        isFree: false,
      })),
  );
  const merged = filterCloudManagedModelOptions(
    mergeModelOptions(engineOptions, assignedModelOptions(input.grantCatalog)),
    input.cloudProvidersEnabled,
  );
  return filterEntitledModelOptions(merged, {
    restrictToCloud: input.restrictToCloud,
    checkRestriction: noRestrictions,
  });
}

test("the availability gate that forces the picker open declares the disconnected org model unavailable", async ({ evidence }) => {
  const availability = computeModelAvailability(currentModel, {
    workspaceReady: true,
    loading: false,
    signedIn: true,
    cloudProviderSyncReady: true,
    openWorkModelsSyncing: false,
    restrictToCloud: true,
    checkRestriction: noRestrictions,
    cloudProviderList: engineListAfterDisconnect,
    providerList: engineListAfterDisconnect,
  });

  expect(availability).toEqual({
    status: "unavailable",
    reason: "provider_not_connected",
  });

  // Negative half: the same gate never fires while catalogs are unsettled —
  // the "no longer available" subtitle is a settled verdict, not a race.
  const pendingAvailability = computeModelAvailability(currentModel, {
    workspaceReady: true,
    loading: false,
    signedIn: true,
    cloudProviderSyncReady: false,
    openWorkModelsSyncing: false,
    restrictToCloud: true,
    checkRestriction: noRestrictions,
    cloudProviderList: null,
    providerList: null,
  });
  expect(pendingAvailability).toEqual({ status: "pending" });

  evidence.recordAssertionEvidence(
    "The disconnected org provider's model is a settled 'unavailable' verdict",
    `computeModelAvailability returned ${JSON.stringify(availability)} against the post-disconnect engine catalog, and 'pending' while the catalog was unsettled.`,
    true,
  );
});

test("the picker offers no model of a granted provider whose member credential is gone", async ({ evidence }) => {
  const options = buildPickerOptions({
    engineList: engineListAfterDisconnect,
    grantCatalog: [grantedDisconnectedProvider],
    cloudProvidersEnabled: true, // member is signed in to Den
    restrictToCloud: true,
  });

  const staleOptions = options.filter((option) => option.providerID === PROVIDER_KEY);
  expect(staleOptions).toEqual([]);
  expect(options).toEqual([]);

  // The picker and the availability gate now agree: the model the session was
  // using is unavailable AND is not re-offered.
  const availability = computeModelAvailability(currentModel, {
    workspaceReady: true,
    loading: false,
    signedIn: true,
    cloudProviderSyncReady: true,
    openWorkModelsSyncing: false,
    restrictToCloud: true,
    checkRestriction: noRestrictions,
    cloudProviderList: engineListAfterDisconnect,
    providerList: engineListAfterDisconnect,
  });
  expect(availability.status).toBe("unavailable");

  evidence.recordAssertionEvidence(
    "Disconnected grant no longer leaks into the model picker",
    `With an empty post-disconnect engine catalog and a credential-less grant for ${PROVIDER_KEY}, the picker pipeline produced ${staleOptions.length} options for that provider while the availability verdict was '${availability.status}'.`,
    staleOptions.length === 0 && availability.status === "unavailable",
  );
});

test("a granted provider with an active member credential keeps its models before the engine connects it", async ({ evidence }) => {
  // Positive half (the #3714 pre-workspace window must keep working): the
  // engine has not materialized anything yet, but the member holds an active
  // per-member binding, so the grant catalog legitimately supplies the models.
  const options = buildPickerOptions({
    engineList: engineListAfterDisconnect,
    grantCatalog: [grantedProvider(true)],
    cloudProvidersEnabled: true,
    restrictToCloud: true,
  });
  const offered = options.filter((option) => option.providerID === PROVIDER_KEY);
  expect(offered).toHaveLength(MODEL_COUNT);
  expect(offered.every((option) => option.source === "cloud")).toBe(true);
  expect(offered.some((option) => option.modelID === currentModel.modelID)).toBe(true);

  // Negative halves: the merge is not simply echoing everything.
  // 1. Signed out (cloudProvidersEnabled=false) removes the cloud options.
  const signedOutOptions = buildPickerOptions({
    engineList: engineListAfterDisconnect,
    grantCatalog: [grantedProvider(true)],
    cloudProvidersEnabled: false,
    restrictToCloud: false,
  });
  expect(signedOutOptions).toHaveLength(0);
  // 2. A provider that is neither granted nor connected never appears.
  const revokedOptions = buildPickerOptions({
    engineList: engineListAfterDisconnect,
    grantCatalog: [],
    cloudProvidersEnabled: true,
    restrictToCloud: true,
  });
  expect(revokedOptions).toHaveLength(0);

  evidence.recordAssertionEvidence(
    "Credentialed grants still supply models before the engine connects",
    `Active per-member binding: ${offered.length}/${MODEL_COUNT} models offered; signed-out: ${signedOutOptions.length}; revoked grant: ${revokedOptions.length}.`,
    offered.length === MODEL_COUNT && signedOutOptions.length === 0 && revokedOptions.length === 0,
  );
});
