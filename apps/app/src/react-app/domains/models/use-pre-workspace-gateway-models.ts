import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { createDenClient, readDenSettings } from "@/app/lib/den";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { assignedGatewayModelOptions } from "../connections/provider-auth/assigned-model-options";

/**
 * Before the first workspace there is no engine catalog for the picker to
 * subscribe to. Den's usable inventory already contains this member's ready
 * model/group/credential-set aliases; reading it never retrieves credentials.
 * Workspace-backed catalogs remain authoritative after a workspace is created.
 */
export function usePreWorkspaceGatewayModels(input: { enabled: boolean; sessionVersion: number }) {
  const auth = useDenAuth();
  const settings = readDenSettings();
  const identity = auth.verifiedIdentity;
  const enabled = input.enabled && auth.isSignedIn && Boolean(settings.authToken?.trim())
    && Boolean(identity?.principalId) && identity?.organizationId === settings.activeOrgId;
  const query = useQuery({
    queryKey: ["pre-workspace-gateway-models", settings.baseUrl, identity?.principalId ?? "",
      identity?.organizationId ?? "", input.sessionVersion],
    queryFn: async () => {
      if (!identity || !settings.authToken) return [];
      const providers = await createDenClient({ baseUrl: settings.baseUrl, token: settings.authToken })
        .listOrgUsableGatewayProviders(identity.organizationId);
      return assignedGatewayModelOptions(providers);
    },
    enabled,
    // Never reuse another sign-in's inventory or retain selectable models after
    // an access failure. Session version changes also isolate in-flight reads.
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const { refetch } = query;
  const refresh = useCallback(async () => {
    if (enabled) await refetch();
  }, [enabled, refetch]);
  return { options: enabled && !query.isError ? query.data ?? [] : [], refresh };
}
