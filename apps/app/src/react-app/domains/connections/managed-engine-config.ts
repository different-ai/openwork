import { unwrap } from "@/app/lib/opencode";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type { Client } from "@/app/types";

type WorkspaceType = "local" | "remote" | string;

export type UpdateManagedDisabledProvidersOptions = {
  opencodeClient: Client | null;
  openworkClient?: OpenworkServerClient | null;
  workspaceId?: string | null;
  workspaceType?: WorkspaceType | null;
  disabledProviders: unknown;
  currentConfig?: unknown;
  removeFallbackKeyWhenEmpty?: boolean;
  markReloadRequired?: () => void;
};

export type UpdateManagedDisabledProvidersResult = {
  managedRuntime: boolean;
  disabledProviders: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export function disabledProvidersFromConfig(config: unknown): string[] {
  return isRecord(config) ? normalizeDisabledProviders(config.disabled_providers) : [];
}

function configWithDisabledProviders(
  config: unknown,
  providers: string[],
  removeWhenEmpty: boolean,
): Record<string, unknown> {
  const next = { ...(isRecord(config) ? config : {}) };
  if (providers.length > 0 || !removeWhenEmpty) {
    next.disabled_providers = providers;
  } else {
    delete next.disabled_providers;
  }
  return next;
}

export async function updateManagedDisabledProviders(
  options: UpdateManagedDisabledProvidersOptions,
): Promise<UpdateManagedDisabledProvidersResult> {
  const disabledProviders = normalizeDisabledProviders(options.disabledProviders);
  const workspaceId = options.workspaceId?.trim() ?? "";

  if (options.openworkClient && workspaceId && options.workspaceType === "local") {
    const result = await options.openworkClient.setRuntimeDisabledProviders(workspaceId, disabledProviders);
    options.markReloadRequired?.();
    return { managedRuntime: true, disabledProviders: result.disabledProviders };
  }

  const client = options.opencodeClient;
  if (!client) throw new Error("OpenCode client is not connected.");
  const currentConfig = options.currentConfig ?? unwrap(await client.config.get());
  await client.config.update({
    config: configWithDisabledProviders(
      currentConfig,
      disabledProviders,
      options.removeFallbackKeyWhenEmpty === true,
    ),
  });
  return { managedRuntime: false, disabledProviders };
}
