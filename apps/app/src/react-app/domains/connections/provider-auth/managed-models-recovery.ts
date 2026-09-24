export type OrganizationModelsEmptyInput = {
  workspaceReady: boolean;
  loading: boolean;
  restrictToCloud: boolean;
  cloudProviderSyncReady: boolean;
  entitledModelCount: number;
};

export function isOrganizationModelsEmpty(input: OrganizationModelsEmptyInput) {
  return (
    input.workspaceReady &&
    !input.loading &&
    input.restrictToCloud &&
    input.cloudProviderSyncReady &&
    input.entitledModelCount === 0
  );
}

export type ManagedModelAvailabilityPendingInput = {
  signedIn: boolean;
  selectedModelUsesCloudProvider: boolean;
  cloudProviderSyncReady: boolean;
  openWorkModelsSyncing: boolean;
};

/** A cloud model can temporarily disappear while its provider is being reconciled. */
export function isManagedModelAvailabilityPending(
  input: ManagedModelAvailabilityPendingInput,
) {
  return (
    input.signedIn &&
    input.selectedModelUsesCloudProvider &&
    (!input.cloudProviderSyncReady || input.openWorkModelsSyncing)
  );
}

export type CloudProviderSyncReadyInput = {
  signedIn: boolean;
  clientConnected: boolean;
  workspaceId: string | null | undefined;
  activeOrgId: string | null | undefined;
  cloudProviderSyncReady: boolean;
};

export function shouldWaitForCloudProviderSyncBeforePolicyReconcile(
  input: CloudProviderSyncReadyInput,
) {
  return (
    input.signedIn &&
    input.clientConnected &&
    Boolean(input.workspaceId?.trim()) &&
    Boolean(input.activeOrgId?.trim()) &&
    !input.cloudProviderSyncReady
  );
}

export type OrganizationModelsRefreshInput<T> = {
  runCloudProviderSync: (reason: OrganizationModelsRefreshReason) => Promise<unknown>;
  refreshProviders: () => Promise<T> | T;
};

export type OrganizationModelsRefreshReason =
  | "sign_in"
  | "app_launch"
  | "app_resume"
  | "model_picker_open"
  | "new_chat"
  | "manual";

export async function refreshOrganizationModels<T>(
  input: OrganizationModelsRefreshInput<T>,
  reason: OrganizationModelsRefreshReason = "manual",
): Promise<T> {
  await input.runCloudProviderSync(reason);
  return input.refreshProviders();
}
