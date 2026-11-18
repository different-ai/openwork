import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OpenworkSandboxSettingsResponse, OpenworkServerClient, OpenworkServerStatus } from "../../../../app/lib/openwork-server";
import { canPrepareSandbox, withOwnHostExecutionSetting } from "./host-execution-panel-state";
import { sandboxSettingsQueryKey } from "@/react-app/infra/use-sandbox-settings";

export type SandboxSettingsOptions = {
  openworkServerClient: OpenworkServerClient | null;
  openworkServerStatus: OpenworkServerStatus;
  runtimeWorkspaceId: string | null;
  sandboxRolloutEnabled: boolean;
};

export function useSandboxSettingsActions(props: SandboxSettingsOptions & { onUpdated: () => void }, settings: OpenworkSandboxSettingsResponse | null) {
  const queryClient = useQueryClient();
  const queryKey = sandboxSettingsQueryKey(props.openworkServerClient, props.runtimeWorkspaceId);
  const update = (next: OpenworkSandboxSettingsResponse) => {
    queryClient.setQueryData(queryKey, next);
    props.onUpdated();
  };
  const save = useMutation({
    mutationFn: (allowHostExecution: boolean) => {
      if (!props.openworkServerClient || !props.runtimeWorkspaceId) throw new Error("Workspace unavailable");
      return props.openworkServerClient.setSandboxSettings(props.runtimeWorkspaceId, allowHostExecution);
    },
    onMutate: async (allowHostExecution) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<OpenworkSandboxSettingsResponse | null>(queryKey) ?? null;
      if (previous) queryClient.setQueryData(queryKey, withOwnHostExecutionSetting(previous, allowHostExecution));
      return { previous };
    },
    onError: (_error, _allowHostExecution, context) => {
      queryClient.setQueryData(queryKey, context?.previous ?? null);
    },
    onSuccess: update,
  });
  const prepare = useMutation({
    mutationFn: () => {
      if (!props.openworkServerClient || !props.runtimeWorkspaceId) throw new Error("Workspace unavailable");
      return props.openworkServerClient.prepareSandbox(props.runtimeWorkspaceId);
    },
    onSuccess: update,
  });
  const preparation = useQuery({
    queryKey: ["openwork-server", props.openworkServerClient?.baseUrl ?? null, "sandbox-prepare", props.runtimeWorkspaceId],
    enabled: props.sandboxRolloutEnabled && props.openworkServerStatus === "connected" && Boolean(props.openworkServerClient) && Boolean(props.runtimeWorkspaceId) && canPrepareSandbox(settings),
    queryFn: async () => {
      if (!props.openworkServerClient || !props.runtimeWorkspaceId) return null;
      const next = await props.openworkServerClient.prepareSandbox(props.runtimeWorkspaceId);
      queryClient.setQueryData(queryKey, next);
      return next;
    },
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  return { save, prepare, preparation };
}
