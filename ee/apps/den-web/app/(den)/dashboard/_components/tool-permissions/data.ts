import { setToolPermissionRuleSchema, setToolPermissionWrittenRulesSchema, toolPermissionsSchema, type SetToolPermissionRule } from "@openwork/types/den/tool-permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRequestError, requestJson } from "../../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";

const path = "/v1/org/tool-permissions";
const orgKey = (orgId: string) => ["tool-permissions", orgId] as const;
const permissionsKey = (orgId: string, connectionId?: string) => [...orgKey(orgId), connectionId ?? null] as const;

async function requestPermissions(orgId: string, url: string, body?: unknown) {
  const { response, payload } = await requestJson(url, {
    method: body === undefined ? "GET" : "PUT",
    headers: { [ORG_SCOPE_HEADER]: orgId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw getRequestError(payload, response, "Could not complete this request. Try again.");
  return toolPermissionsSchema.parse(payload);
}

export function useToolPermissions(orgId: string, connectionId?: string) {
  return useQuery({
    queryKey: permissionsKey(orgId, connectionId),
    queryFn: () => requestPermissions(orgId, connectionId ? `${path}?connectionId=${encodeURIComponent(connectionId)}` : path),
  });
}

export function useSetToolRule(orgId: string, connectionId: string) {
  const client = useQueryClient();
  const queryKey = permissionsKey(orgId, connectionId);
  return useMutation({
    mutationFn: (edit: SetToolPermissionRule) => requestPermissions(orgId, `${path}/rule`, setToolPermissionRuleSchema.parse(edit)),
    onSuccess: async (data) => {
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData(queryKey, data);
      void client.invalidateQueries({ queryKey: permissionsKey(orgId), exact: true });
      void client.invalidateQueries({ queryKey: ["personal-agents-admin", orgId] });
    },
  });
}

export function useSetWrittenRules(orgId: string) {
  const client = useQueryClient();
  const queryKey = permissionsKey(orgId);
  return useMutation({
    mutationFn: (rules: string) => requestPermissions(orgId, `${path}/written-rules`, setToolPermissionWrittenRulesSchema.parse({ rules })),
    onSuccess: async (data) => {
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData(queryKey, data);
      void client.invalidateQueries({ queryKey: ["personal-agents-admin", orgId] });
    },
  });
}
