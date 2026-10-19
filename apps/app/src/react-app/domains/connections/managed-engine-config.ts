import type { OpenworkServerClient } from "@/app/lib/openwork-server";

type WorkspaceType = string;

export type UpdateManagedDisabledProvidersOptions = {
  openworkClient?: OpenworkServerClient | null;
  workspaceId?: string | null;
  workspaceType?: WorkspaceType | null;
  disabledProviders: unknown;
  markReloadRequired?: () => void;
};

export type UpdateManagedDisabledProvidersResult = {
  managedRuntime: boolean;
  disabledProviders: string[];
};

function normalizeDisabledProviders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const providers: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const provider = entry.trim();
    if (provider && !providers.includes(provider)) providers.push(provider);
  }
  return providers;
}

export type ReadManagedDisabledProvidersOptions = {
  openworkClient?: OpenworkServerClient | null;
  workspaceId?: string | null;
  workspaceType?: WorkspaceType | null;
};

/**
 * The providers hidden through `disabled_providers` (for example a
 * disconnected OpenCode Zen). The engine keeps its config private, so the
 * OpenWork server owns this shared list.
 */
export async function readManagedDisabledProviders(
  options: ReadManagedDisabledProvidersOptions,
): Promise<string[]> {
  const workspaceId = options.workspaceId?.trim() ?? "";
  if (!options.openworkClient || !workspaceId || options.workspaceType !== "local") return [];
  const result = await options.openworkClient.getRuntimeDisabledProviders(workspaceId);
  return normalizeDisabledProviders(result.disabledProviders);
}

export async function updateManagedDisabledProviders(
  options: UpdateManagedDisabledProvidersOptions,
): Promise<UpdateManagedDisabledProvidersResult> {
  const disabledProviders = normalizeDisabledProviders(options.disabledProviders);
  const workspaceId = options.workspaceId?.trim() ?? "";
  if (!options.openworkClient || !workspaceId || options.workspaceType !== "local") {
    throw new Error("OpenWork server is not connected.");
  }
  const result = await options.openworkClient.setRuntimeDisabledProviders(workspaceId, disabledProviders);
  return { managedRuntime: true, disabledProviders: result.disabledProviders };
}
