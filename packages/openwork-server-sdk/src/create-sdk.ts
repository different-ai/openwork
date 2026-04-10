import { createClient } from "../generated/client/index.js";
import { getHealth } from "../generated/sdk.gen.js";
import type { GetHealthResponse } from "../generated/types.gen.js";

export type ServerSdkCapabilities = {
  v2?: boolean;
};

export const DEFAULT_SERVER_API_PATH = "v2";

export type ResolvedServerTarget = {
  baseUrl: string;
  token?: string;
  apiPath?: string;
  capabilities?: ServerSdkCapabilities;
};

export type ResolveServerTarget = (input: { serverId: string }) => ResolvedServerTarget | Promise<ResolvedServerTarget>;

let resolveServerTarget: ResolveServerTarget | null = null;

export function configureServerSdk(config: { resolveServerTarget: ResolveServerTarget }) {
  resolveServerTarget = config.resolveServerTarget;
}

export async function resolveSdkTarget(serverId: string) {
  if (!resolveServerTarget) {
    throw new Error("configureServerSdk() must be called before createSdk({ serverId }).");
  }

  return resolveServerTarget({ serverId });
}

function normalizeApiBaseUrl(baseUrl: string, apiPath: string = DEFAULT_SERVER_API_PATH) {
  const normalized = baseUrl.replace(/\/+$/, "");
  const trimmedPath = apiPath.trim().replace(/^\/+|\/+$/g, "");

  if (!trimmedPath) {
    return normalized;
  }

  return normalized.endsWith(`/${trimmedPath}`) ? normalized : `${normalized}/${trimmedPath}`;
}

async function createScopedClient(serverId: string) {
  const target = await resolveSdkTarget(serverId);
  const headers = new Headers();

  if (target.token) {
    headers.set("Authorization", `Bearer ${target.token}`);
  }

  return {
    client: createClient({
      baseUrl: normalizeApiBaseUrl(target.baseUrl, target.apiPath),
      headers,
    }),
    target,
  };
}

export function createSdk(input: { serverId: string }) {
  const { serverId } = input;

  return {
    system: {
      health: {
        get: async (): Promise<GetHealthResponse> => {
          const { client } = await createScopedClient(serverId);
          const response = await getHealth<true>({ client, throwOnError: true });
          return response.data;
        },
      },
    },
  };
}
