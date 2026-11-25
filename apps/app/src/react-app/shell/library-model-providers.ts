import type { CloudImportedProvider } from "../../app/cloud/import-state";
import {
  gatewayConnectProviderKey,
  type GatewayConnectProvider,
  type LiveGatewayProvider,
} from "../domains/connections/provider-auth/cloud-provider-config";
import type { LibraryModelProvider } from "../domains/settings/library-models";

function uniqueSorted(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function withoutGatewayModelIds(ids: readonly string[]): string[] {
  return ids.filter((id) => !id.startsWith("gwm_"));
}

function providerNameWithoutCredentialSet(name: string): string {
  return name.split(" / ")[0]?.trim() || name;
}

export function buildLibraryModelProviders(input: {
  liveGatewayProviders: readonly LiveGatewayProvider[] | null;
  importedCloudProviders: Readonly<Record<string, CloudImportedProvider>>;
  gatewayConnectProviders: readonly GatewayConnectProvider[];
}): LibraryModelProvider[] {
  const signInKeyFor = (id: string) => {
    const pending = input.gatewayConnectProviders.find((provider) => provider.cloudProviderId === id);
    return pending ? gatewayConnectProviderKey(pending) : null;
  };
  const rows = new Map<string, LibraryModelProvider>();

  for (const live of input.liveGatewayProviders ?? []) {
    const pending = live.authorizationRequests.flatMap((request) => request.models ?? []);
    const modelNames = uniqueSorted([...live.models, ...pending].map((model) => model.name));
    const signInKey = signInKeyFor(live.id);
    rows.set(live.id, {
      id: live.id,
      name: live.name,
      providerKey: live.providerId,
      state: live.models.length > 0 ? "ready" : signInKey ? "needs_signin" : "blocked",
      modelNames,
      modelCount: modelNames.length,
      signInKey: live.models.length > 0 ? null : signInKey,
    });
  }

  for (const imported of Object.values(input.importedCloudProviders)) {
    if (rows.has(imported.cloudProviderId)) continue;
    const modelNames = uniqueSorted(withoutGatewayModelIds(imported.modelIds));
    const signInKey = signInKeyFor(imported.cloudProviderId);
    const ready = imported.modelIds.length > 0;
    rows.set(imported.cloudProviderId, {
      id: imported.cloudProviderId,
      name: imported.name,
      providerKey: imported.sourceProviderId || null,
      state: ready ? "ready" : signInKey ? "needs_signin" : "blocked",
      modelNames,
      modelCount: new Set(imported.modelIds).size,
      signInKey: ready ? null : signInKey,
    });
  }

  for (const pending of input.gatewayConnectProviders) {
    if (rows.has(pending.cloudProviderId)) continue;
    const modelNames = uniqueSorted((pending.models ?? []).map((model) => model.name));
    rows.set(pending.cloudProviderId, {
      id: pending.cloudProviderId,
      name: providerNameWithoutCredentialSet(pending.name),
      providerKey: null,
      state: "needs_signin",
      modelNames,
      modelCount: modelNames.length,
      signInKey: gatewayConnectProviderKey(pending),
    });
  }

  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
}
