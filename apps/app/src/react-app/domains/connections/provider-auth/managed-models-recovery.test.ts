declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
};

import {
  isOrganizationModelsEmpty,
  refreshOrganizationModels,
  shouldAutoOpenUnavailableModelPicker,
  shouldWaitForCloudProviderSyncBeforePolicyReconcile,
} from "./managed-models-recovery";

describe("managed model sync ordering", () => {
  test("waits to reconcile policy until the first signed-in cloud provider sync settles", () => {
    expect(shouldWaitForCloudProviderSyncBeforePolicyReconcile({
      signedIn: true,
      clientConnected: true,
      workspaceId: "workspace-1",
      activeOrgId: "org-1",
      cloudProviderSyncReady: false,
    })).toBe(true);

    expect(shouldWaitForCloudProviderSyncBeforePolicyReconcile({
      signedIn: true,
      clientConnected: true,
      workspaceId: "workspace-1",
      activeOrgId: "org-1",
      cloudProviderSyncReady: true,
    })).toBe(false);
  });
});

describe("managed model empty state", () => {
  test("suppresses unavailable-model auto-open when managed model sync settled empty", () => {
    const organizationModelsEmpty = isOrganizationModelsEmpty({
      workspaceReady: true,
      loading: false,
      restrictToCloud: true,
      cloudProviderSyncReady: true,
      entitledModelCount: 0,
    });

    expect(organizationModelsEmpty).toBe(true);
    expect(shouldAutoOpenUnavailableModelPicker({
      selectedModelUnavailableKey: "opencode:gpt-5",
      signedIn: true,
      cloudProviderSyncReady: true,
      entitledOrgDefaultModel: false,
      organizationModelsEmpty,
      autoOpenedUnavailableModelKey: null,
    })).toBe(false);
  });
});

describe("managed model recovery", () => {
  test("refreshes organization models through the manual sync path before rereading providers", async () => {
    const calls: string[] = [];

    await refreshOrganizationModels({
      runCloudProviderSync: async (reason) => {
        calls.push(`sync:${reason}`);
      },
      refreshProviders: async () => {
        calls.push("providers");
      },
    });

    expect(calls).toEqual(["sync:manual", "providers"]);
  });
});
