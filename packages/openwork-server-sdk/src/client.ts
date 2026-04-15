import { createClient } from "../generated/client/index.js";
import type { Client, Config, CreateClientConfig } from "../generated/client/index.js";

export type OpenWorkServerClientConfig = Config;
export type OpenWorkServerClient = Client;
export type OpenWorkServerClientFactory = CreateClientConfig;

export function normalizeServerBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "") || baseUrl;
}

export function createOpenWorkServerClient(config: OpenWorkServerClientConfig = {}): OpenWorkServerClient {
  return createClient({
    ...config,
    baseUrl: config.baseUrl ? normalizeServerBaseUrl(config.baseUrl) : config.baseUrl,
  });
}
