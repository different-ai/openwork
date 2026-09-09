// Session-route adapter for the provider-auth store's `openworkServer` slice.
//
// The settings route feeds the store the full openwork-server store, whose
// snapshot carries the server's real capabilities (including `providerSync`)
// and host-token auth. The session route used to fabricate a snapshot with
// hard-coded `{ config }` capabilities and no auth at all, so on the app's
// default surface `serverHandlesProviderSync()` was permanently false:
// PUT /den-session never fired after sign-in, the local server never learned
// the Den session, and server-side cloud provider sync never started (#3671).
//
// This adapter reports the truth for the endpoint it wraps:
// - local endpoints (the desktop's own OpenWork server) advertise
//   `providerSync: true` — every OpenWork server does
//   (apps/server/src/types.ts `Capabilities.providerSync: true`) — and carry
//   the live host token so the store can PUT /den-session and
//   POST /cloud-provider-sync/run;
// - remote workspaces keep the previous conservative shape (config only): a
//   desktop must not push its Den session to a shared remote worker.
import {
  createOpenworkServerClient,
  isLoopbackOpenworkServerUrl,
  readOpenworkServerSettings,
  type OpenworkServerClient,
} from "@/app/lib/openwork-server";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { ProviderAuthOpenworkServer } from "./store";

type SessionOpenworkServerSnapshot = ReturnType<ProviderAuthOpenworkServer["getSnapshot"]>;

export type CreateSessionOpenworkServerInput = {
  endpoint: () => ResolvedWorkspaceEndpoint | null;
  /** Live host token from the desktop runtime (openworkServerInfo). */
  hostToken?: () => string;
  generation?: () => number | null;
};

function resolveHostToken(endpoint: ResolvedWorkspaceEndpoint, live: string): string {
  if (live) return live;
  // Fallback mirrors openwork-server-store's getAuth(): persisted settings may
  // hold the host token (ensureDesktopLocalOpenworkConnection writes it), but
  // only trust it for loopback servers — host tokens never travel off-machine.
  if (!isLoopbackOpenworkServerUrl(endpoint.baseUrl)) return "";
  return readOpenworkServerSettings().hostToken?.trim() ?? "";
}

export function createSessionOpenworkServer(
  input: CreateSessionOpenworkServerInput,
): ProviderAuthOpenworkServer {
  let clientCacheKey = "";
  let clientCacheValue: OpenworkServerClient | null = null;

  const hostAwareClient = (endpoint: ResolvedWorkspaceEndpoint, hostToken: string): OpenworkServerClient => {
    if (!hostToken) return endpoint.client;
    const key = `${endpoint.baseUrl}\u001f${endpoint.token}\u001f${hostToken}`;
    if (key !== clientCacheKey || !clientCacheValue) {
      clientCacheKey = key;
      clientCacheValue = createOpenworkServerClient({
        baseUrl: endpoint.baseUrl,
        token: endpoint.token || undefined,
        hostToken,
      });
    }
    return clientCacheValue;
  };

  return {
    getSnapshot: (): SessionOpenworkServerSnapshot => {
      const endpoint = input.endpoint();
      if (!endpoint) {
        return {
          openworkServerStatus: "disconnected",
          openworkServerClient: null,
          openworkServerCapabilities: null,
        };
      }
      if (endpoint.isRemote) {
        return {
          openworkServerStatus: "connected",
          openworkServerClient: endpoint.client,
          openworkServerCapabilities: { config: { read: true, write: true } },
        };
      }
      const hostToken = resolveHostToken(endpoint, input.hostToken?.().trim() ?? "");
      return {
        openworkServerStatus: "connected",
        openworkServerClient: hostAwareClient(endpoint, hostToken),
        openworkServerHostInfo: { generation: input.generation?.() ?? null },
        openworkServerAuth: {
          token: endpoint.token || undefined,
          hostToken: hostToken || undefined,
        },
        openworkServerCapabilities: {
          config: { read: true, write: true },
          providerSync: true,
        },
      };
    },
  };
}
