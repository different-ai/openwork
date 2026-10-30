"use client";

import {
  autoRouterListSchema,
  autoRouterOptionsSchema,
  type AutoRouterList,
  type AutoRouterOptions,
  type AutoRouterWrite,
} from "@openwork/types/den/auto-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const listPath = "/v1/org/auto-routers";
const optionsPath = "/v1/org/auto-router/options";

function autoRoutersQueryKey(orgId: string): string[] {
  return ["org-auto-routers", orgId];
}

function autoRouterOptionsQueryKey(orgId: string): string[] {
  return ["org-auto-routers", orgId, "options"];
}

/** The organization's Smart Routers, every task in use, and whether this person may change them. */
export function useAutoRouters(orgId: string, enabled = true) {
  return useQuery({
    queryKey: autoRoutersQueryKey(orgId),
    enabled: enabled && Boolean(orgId),
    retry: false,
    queryFn: async ({ signal }): Promise<AutoRouterList> => {
      const { response, payload } = await requestJson(
        listPath,
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal },
        15000,
      );
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load Smart Routers (${response.status}).`));
      const parsed = autoRouterListSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Smart Routers returned an unexpected response.");
      return parsed.data;
    },
  });
}

/** The AI Gateway models a Smart Router can use, and who can use each. */
export function useAutoRouterOptions(orgId: string, enabled = true) {
  return useQuery({
    queryKey: autoRouterOptionsQueryKey(orgId),
    enabled: enabled && Boolean(orgId),
    retry: false,
    staleTime: 30_000,
    queryFn: async ({ signal }): Promise<AutoRouterOptions> => {
      const { response, payload } = await requestJson(
        optionsPath,
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal },
        20000,
      );
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load your AI Gateway models (${response.status}).`));
      const parsed = autoRouterOptionsSchema.safeParse(payload);
      if (!parsed.success) throw new Error("The model list returned an unexpected response.");
      return parsed.data;
    },
  });
}

type RouterRequest = { method: "POST" | "PUT" | "DELETE"; path: string; body?: AutoRouterWrite; action: string; fallback: string };

/** Every write returns the whole list, which replaces the cached one. */
function useRouterMutation<Input>(orgId: string, name: string, toRequest: (input: Input) => RouterRequest) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationKey: [...autoRoutersQueryKey(orgId), name],
    retry: false,
    mutationFn: async (input: Input): Promise<AutoRouterList | null> => {
      const request = toRequest(input);
      const result: { list: AutoRouterList | null } = { list: null };
      await runReauthableAction(request.action, async () => {
        const { response, payload } = await requestJson(
          request.path,
          {
            method: request.method,
            headers: { [ORG_SCOPE_HEADER]: orgId },
            ...(request.body ? { body: JSON.stringify(request.body) } : {}),
          },
          20000,
        );
        if (!response.ok) throw getRequestError(payload, response, `${request.fallback} (${response.status}).`);
        const parsed = autoRouterListSchema.safeParse(payload);
        result.list = parsed.success ? parsed.data : null;
      });
      return result.list;
    },
    onSuccess: (list) => {
      if (list) queryClient.setQueryData(autoRoutersQueryKey(orgId), list);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: autoRoutersQueryKey(orgId), exact: true }),
  });
}

/** Creates a Smart Router, or replaces one whole when `routerId` is set. Errors carry the server's message. */
export function useSaveAutoRouter(orgId: string) {
  return useRouterMutation(orgId, "save", ({ routerId, input }: { routerId: string | null; input: AutoRouterWrite }): RouterRequest => ({
    method: routerId ? "PUT" : "POST",
    path: routerId ? `${listPath}/${encodeURIComponent(routerId)}` : listPath,
    body: input,
    action: "save-auto-router",
    fallback: "Couldn't save the Smart Router",
  }));
}

export function useDeleteAutoRouter(orgId: string) {
  return useRouterMutation(orgId, "delete", (routerId: string): RouterRequest => ({
    method: "DELETE",
    path: `${listPath}/${encodeURIComponent(routerId)}`,
    action: "delete-auto-router",
    fallback: "Couldn't delete the Smart Router",
  }));
}
