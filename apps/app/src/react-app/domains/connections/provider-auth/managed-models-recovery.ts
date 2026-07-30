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

export type UnavailableModelPickerAutoOpenInput = {
  selectedModelUnavailableKey: string | null;
  signedIn: boolean;
  cloudProviderSyncReady: boolean;
  entitledOrgDefaultModel: boolean;
  organizationModelsEmpty: boolean;
  autoOpenedUnavailableModelKey: string | null;
};

export function shouldAutoOpenUnavailableModelPicker(
  input: UnavailableModelPickerAutoOpenInput,
) {
  if (!input.selectedModelUnavailableKey) return false;
  if (input.signedIn && !input.cloudProviderSyncReady) return false;
  if (input.entitledOrgDefaultModel) return false;
  if (input.organizationModelsEmpty) return false;
  return input.autoOpenedUnavailableModelKey !== input.selectedModelUnavailableKey;
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

export type OrganizationModelsRefreshInput = {
  runCloudProviderSync: (reason: "manual") => Promise<unknown>;
  refreshProviders: () => Promise<unknown> | unknown;
};

export async function refreshOrganizationModels(
  input: OrganizationModelsRefreshInput,
) {
  await input.runCloudProviderSync("manual");
  await input.refreshProviders();
}
