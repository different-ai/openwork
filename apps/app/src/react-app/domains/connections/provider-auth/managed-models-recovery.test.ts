declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
};

import { readFileSync } from "node:fs";

import {
  isManagedModelAvailabilityPending,
  isOrganizationModelsEmpty,
  refreshOrganizationModels,
  shouldWaitForCloudProviderSyncBeforePolicyReconcile,
} from "./managed-models-recovery";

const sessionProviderAuthSource = readFileSync(
  new URL("./use-session-provider-auth.ts", import.meta.url),
  "utf8",
);
const providerAuthStoreSource = readFileSync(
  new URL("./store.ts", import.meta.url),
  "utf8",
);

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

  test("keeps a selected cloud model loading through provider sync and workspace reload", () => {
    expect(isManagedModelAvailabilityPending({
      signedIn: true,
      selectedModelUsesCloudProvider: true,
      cloudProviderSyncReady: false,
      openWorkModelsSyncing: false,
    })).toBe(true);
    expect(isManagedModelAvailabilityPending({
      signedIn: true,
      selectedModelUsesCloudProvider: true,
      cloudProviderSyncReady: true,
      openWorkModelsSyncing: true,
    })).toBe(true);
    expect(isManagedModelAvailabilityPending({
      signedIn: true,
      selectedModelUsesCloudProvider: true,
      cloudProviderSyncReady: true,
      openWorkModelsSyncing: false,
    })).toBe(false);
  });

  test("does not hide a genuinely unavailable local or signed-out model behind loading", () => {
    expect(isManagedModelAvailabilityPending({
      signedIn: true,
      selectedModelUsesCloudProvider: false,
      cloudProviderSyncReady: false,
      openWorkModelsSyncing: true,
    })).toBe(false);
    expect(isManagedModelAvailabilityPending({
      signedIn: false,
      selectedModelUsesCloudProvider: true,
      cloudProviderSyncReady: false,
      openWorkModelsSyncing: true,
    })).toBe(false);
  });
});

describe("managed model empty state", () => {
  test("reads an organization with no models once managed model sync settles empty", () => {
    const organizationModelsEmpty = isOrganizationModelsEmpty({
      workspaceReady: true,
      loading: false,
      restrictToCloud: true,
      cloudProviderSyncReady: true,
      entitledModelCount: 0,
    });

    expect(organizationModelsEmpty).toBe(true);
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

  test("returns the refreshed provider snapshot for lifecycle and product triggers", async () => {
    const calls: string[] = [];
    const snapshot = { connected: ["openwork"], all: [] };

    const result = await refreshOrganizationModels({
      runCloudProviderSync: async (reason) => {
        calls.push(`sync:${reason}`);
      },
      refreshProviders: async () => {
        calls.push("providers");
        return snapshot;
      },
    }, "app_resume");

    expect(calls).toEqual(["sync:app_resume", "providers"]);
    expect(result).toBe(snapshot);
  });

  test("publishes automatic sync results into the live session snapshot", () => {
    expect(sessionProviderAuthSource.includes(
      "useCloudProviderAutoSync(refreshCloudProviderSync)",
    )).toBe(true);
    expect(sessionProviderAuthSource.includes(
      "useCloudProviderAutoSync(store.runCloudProviderSync)",
    )).toBe(false);
  });

  test("reconciles the stored default after server-managed provider syncs", () => {
    expect(providerAuthStoreSource.includes(
      "preselectEntitledOrgDefaultModel(providerList)",
    )).toBe(true);
    expect(providerAuthStoreSource.includes(
      "await refreshProvidersAfterCloudSync({ force: true }, isCurrent);",
    )).toBe(true);
  });
});
