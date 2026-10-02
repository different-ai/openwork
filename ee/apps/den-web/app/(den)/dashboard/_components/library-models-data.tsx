"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useDenToast } from "./den-toast";
import {
  disconnectGatewayMemberConnection,
  gatewayMemberAuthorizationCompleted,
  gatewayMemberConnectionKey,
  loadGatewayMemberConnections,
  startGatewayMemberConnection,
} from "./gateway-member-connections-data";
import {
  buildLibraryModelProviders,
  type LibraryModelProvider,
  signInBrand,
  usableProvidersResponseSchema,
} from "./library-models";

export const libraryModelQueryKeys = {
  all: ["me", "library", "models"] as const,
  providers: (orgId: string | null) => ["me", "library", "models", "providers", orgId] as const,
  connections: (orgId: string | null) => ["me", "library", "models", "connections", orgId] as const,
};

/** How long we wait for Google before offering to try again. */
const SIGN_IN_WAIT_MS = 10 * 60 * 1000;
const SIGN_IN_POLL_MS = 2000;

async function loadUsableProviders(orgId: string, signal?: AbortSignal) {
  const { response, payload } = await requestJson("/v1/inference-providers?scope=usable", {
    method: "GET",
    headers: { [ORG_SCOPE_HEADER]: orgId },
    signal,
  }, 15000);
  if (!response.ok) throw new Error(getErrorMessage(payload, "Your models did not load. Try again."));
  const parsed = usableProvidersResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Your models did not load. Try again.");
  return parsed.data.inferenceProviders;
}

/** Every model provider the organization gives the viewer, with their sign-in state. */
export function useLibraryModels() {
  const { orgId } = useOrgDashboard();
  const providers = useQuery({
    queryKey: libraryModelQueryKeys.providers(orgId),
    enabled: Boolean(orgId),
    queryFn: ({ signal }) => {
      if (!orgId) throw new Error("Select an organization first.");
      return loadUsableProviders(orgId, signal);
    },
  });
  const connections = useQuery({
    queryKey: libraryModelQueryKeys.connections(orgId),
    enabled: Boolean(orgId),
    queryFn: ({ signal }) => {
      if (!orgId) throw new Error("Select an organization first.");
      return loadGatewayMemberConnections(orgId, signal);
    },
    refetchOnWindowFocus: "always",
  });
  const data = providers.data && connections.data ? buildLibraryModelProviders(providers.data, connections.data) : undefined;
  return {
    data,
    isLoading: providers.isLoading || connections.isLoading,
    error: providers.error ?? connections.error,
  };
}

type SignInState =
  | { kind: "idle" }
  | { kind: "waiting"; providerId: string }
  | { kind: "failed"; providerId: string; message: string };

/**
 * Signs the viewer in with their own account for one provider, right where
 * they are: opens the provider's sign-in in a new tab and waits here until
 * Den confirms it, then says which account is in use.
 */
export function useModelSignIn() {
  const { orgId } = useOrgDashboard();
  const queryClient = useQueryClient();
  const toast = useDenToast();
  const [state, setState] = useState<SignInState>({ kind: "idle" });
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: libraryModelQueryKeys.all });
  }

  async function signIn(provider: LibraryModelProvider) {
    const set = provider.signInSet;
    if (!orgId || !set) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setState({ kind: "waiting", providerId: provider.id });
    // Open the tab inside the click so the browser does not block it.
    const tab = window.open("", "_blank");
    try {
      const authUrl = await startGatewayMemberConnection(orgId, set, current.signal);
      if (current.signal.aborted) {
        tab?.close();
        return;
      }
      if (tab) tab.location.href = authUrl;
      else window.open(authUrl, "_blank", "noopener,noreferrer");
      const startedAt = Date.now();
      const key = gatewayMemberConnectionKey(set);
      while (!current.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, SIGN_IN_POLL_MS));
        if (current.signal.aborted) return;
        if (Date.now() - startedAt > SIGN_IN_WAIT_MS) {
          setState({ kind: "failed", providerId: provider.id, message: `${signInBrand(provider)} did not confirm the sign-in.` });
          return;
        }
        const tabClosed = tab?.closed ?? false;
        const latest = await loadGatewayMemberConnections(orgId, current.signal).catch(() => null);
        const row = latest?.find((entry) => gatewayMemberConnectionKey(entry) === key);
        if (!row) {
          if (tabClosed) {
            setState({ kind: "failed", providerId: provider.id, message: "Sign-in didn't finish." });
            return;
          }
          continue;
        }
        if (!row.hasAccess || row.configurationRequired) {
          setState({ kind: "failed", providerId: provider.id, message: "Your admin needs to finish setting this up." });
          await refresh();
          return;
        }
        if (gatewayMemberAuthorizationCompleted(row, set.authorizationRevision)) {
          setState({ kind: "idle" });
          await refresh();
          toast({ title: row.accountEmail ? `Signed in to ${signInBrand(provider)} as ${row.accountEmail}` : `Signed in to ${signInBrand(provider)}` });
          return;
        }
        // The person closed the sign-in tab without finishing, or the provider said no there.
        if (tabClosed) {
          setState({ kind: "failed", providerId: provider.id, message: "Sign-in didn't finish." });
          return;
        }
      }
    } catch (cause) {
      tab?.close();
      if (current.signal.aborted) return;
      setState({ kind: "failed", providerId: provider.id, message: cause instanceof Error ? cause.message : "Sign-in did not start." });
    }
  }

  function cancel() {
    controller.current?.abort();
    controller.current = null;
    setState({ kind: "idle" });
  }

  async function signOut(provider: LibraryModelProvider) {
    if (!orgId) return;
    const sets = provider.memberSets.filter((set) => set.hasCredential);
    const signal = new AbortController().signal;
    for (const set of sets) await disconnectGatewayMemberConnection(orgId, set, signal);
    await refresh();
    toast({ title: `Signed out of ${provider.name}`, description: "Sign in again to use its models." });
  }

  return {
    signIn,
    cancel,
    signOut,
    waitingFor: state.kind === "waiting" ? state.providerId : null,
    failureFor: (providerId: string) => state.kind === "failed" && state.providerId === providerId ? state.message : null,
  };
}
