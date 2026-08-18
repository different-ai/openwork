import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  OpenworkServerClient,
  OpenworkWorkspaceEngine,
} from "@/app/lib/openwork-server";

function workspaceEngineQueryKey(client: OpenworkServerClient | null, workspaceId: string | null) {
  return ["workspace-engine", client?.baseUrl ?? "", workspaceId ?? ""];
}

export function useWorkspaceEngine(
  client: OpenworkServerClient | null,
  workspaceId: string | null,
) {
  const resolvedWorkspaceId = workspaceId?.trim() ?? "";
  return useQuery({
    queryKey: workspaceEngineQueryKey(client, resolvedWorkspaceId),
    queryFn: () => {
      if (!client || !resolvedWorkspaceId) throw new Error("Workspace engine is unavailable.");
      return client.getWorkspaceEngine(resolvedWorkspaceId);
    },
    enabled: Boolean(client && resolvedWorkspaceId),
    retry: false,
  });
}

export function useSetWorkspaceEngine(input: {
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  onSuccess: (engine: OpenworkWorkspaceEngine) => void | Promise<void>;
}) {
  const queryClient = useQueryClient();
  const resolvedWorkspaceId = input.workspaceId?.trim() ?? "";
  return useMutation({
    mutationFn: async (engine: OpenworkWorkspaceEngine) => {
      if (!input.client || !resolvedWorkspaceId) {
        throw new Error("Workspace engine is unavailable.");
      }
      return input.client.setWorkspaceEngine(resolvedWorkspaceId, engine);
    },
    onSuccess: async (result) => {
      queryClient.setQueryData(
        workspaceEngineQueryKey(input.client, resolvedWorkspaceId),
        { engine: result.engine },
      );
      await input.onSuccess(result.engine);
    },
  });
}
