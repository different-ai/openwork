"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { marketplaceQueryKeys } from "./marketplace-data";

export type PluginMcpServerTemplate = {
  authType: "oauth" | "apikey" | "none";
  configFields: PluginMcpConfigField[];
  configObjectId: string;
  credentialModeDefault: "shared" | "per_member";
  existingConnectionId: string | null;
  name: string;
  serverKey: string;
  status: "active" | "inactive" | "deleted" | "archived" | "ingestion_error";
  url: string;
};

export type PluginMcpConfigField = {
  description: string | null;
  headerName: string | null;
  key: string;
  kind: "text" | "secret" | "url";
  label: string;
  placement: "header" | "query" | "bearer" | "oauth_client_id" | "oauth_client_secret";
  queryParam: string | null;
  required: boolean;
};

export type PluginMcpServerInstance = {
  id: string;
  pluginId: string;
  configObjectId: string | null;
  serverKey: string;
  externalMcpConnectionId: string;
  instanceLabel: string | null;
  connection: {
    id: string;
    name: string;
    url: string;
    authType: "oauth" | "apikey" | "none";
    credentialMode: "shared" | "per_member";
  } | null;
};

export type PluginSkillTemplate = {
  configObjectId: string;
  denSkillId: string | null;
  description: string | null;
  status: "active" | "inactive" | "deleted" | "archived" | "ingestion_error";
  title: string;
};

export type PluginServerTemplates = {
  instances: PluginMcpServerInstance[];
  mcpTemplates: PluginMcpServerTemplate[];
  skills: PluginSkillTemplate[];
};

export type ConfigurePluginServerInstanceInput = {
  pluginId: string;
  configObjectId: string;
  serverKey: string;
  instanceLabel: string | null;
  name: string | null;
  apiKey?: string;
  authType: "oauth" | "apikey" | "none";
  credentialMode: "shared" | "per_member";
  fieldValues: Array<{ key: string; value: string }>;
  oauthClient?: {
    clientId: string;
    clientSecret?: string;
  };
  access: {
    orgWide: boolean;
    memberIds: string[];
    teamIds: string[];
  };
};

export const pluginServerQueryKeys = {
  all: ["plugin-server-templates"] as const,
  detail: (pluginId: string) => [...pluginServerQueryKeys.all, pluginId] as const,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStatus(value: unknown): PluginSkillTemplate["status"] {
  return value === "inactive" || value === "deleted" || value === "archived" || value === "ingestion_error"
    ? value
    : "active";
}

function readCredentialMode(value: unknown): "shared" | "per_member" {
  return value === "shared" ? "shared" : "per_member";
}

function readAuthType(value: unknown): "oauth" | "apikey" | "none" {
  if (value === "apikey" || value === "none") return value;
  return "oauth";
}

function readConfigFieldPlacement(value: unknown): PluginMcpConfigField["placement"] | null {
  if (value === "header" || value === "query" || value === "bearer" || value === "oauth_client_id" || value === "oauth_client_secret") return value;
  return null;
}

function readConfigFieldKind(value: unknown): PluginMcpConfigField["kind"] {
  if (value === "secret" || value === "url") return value;
  return "text";
}

function parseConfigField(value: unknown): PluginMcpConfigField | null {
  if (!isRecord(value)) return null;
  const key = readString(value.key);
  const label = readString(value.label);
  const placement = readConfigFieldPlacement(value.placement);
  if (!key || !label || !placement) return null;
  return {
    description: readString(value.description),
    headerName: readString(value.headerName),
    key,
    kind: readConfigFieldKind(value.kind),
    label,
    placement,
    queryParam: readString(value.queryParam),
    required: value.required !== false,
  };
}

function parseMcpTemplate(value: unknown): PluginMcpServerTemplate | null {
  if (!isRecord(value)) return null;
  const configObjectId = readString(value.configObjectId);
  const name = readString(value.name);
  const serverKey = readString(value.serverKey);
  const url = readString(value.url);
  if (!configObjectId || !name || !serverKey || !url) return null;
  return {
    authType: readAuthType(value.authType),
    configFields: Array.isArray(value.configFields) ? value.configFields.flatMap((field) => {
      const parsed = parseConfigField(field);
      return parsed ? [parsed] : [];
    }) : [],
    configObjectId,
    credentialModeDefault: readCredentialMode(value.credentialModeDefault),
    existingConnectionId: readString(value.existingConnectionId),
    name,
    serverKey,
    status: readStatus(value.status),
    url,
  };
}

function parseInstance(value: unknown): PluginMcpServerInstance | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const pluginId = readString(value.pluginId);
  const serverKey = readString(value.serverKey);
  const externalMcpConnectionId = readString(value.externalMcpConnectionId);
  if (!id || !pluginId || !serverKey || !externalMcpConnectionId) return null;
  const connectionRecord = isRecord(value.connection) ? value.connection : null;
  const connectionId = connectionRecord ? readString(connectionRecord.id) : null;
  const connectionName = connectionRecord ? readString(connectionRecord.name) : null;
  const connectionUrl = connectionRecord ? readString(connectionRecord.url) : null;
  return {
    id,
    pluginId,
    configObjectId: readString(value.configObjectId),
    serverKey,
    externalMcpConnectionId,
    instanceLabel: readString(value.instanceLabel),
    connection: connectionId && connectionName && connectionUrl
      ? {
          id: connectionId,
          name: connectionName,
          url: connectionUrl,
          authType: readAuthType(connectionRecord?.authType),
          credentialMode: readCredentialMode(connectionRecord?.credentialMode),
        }
      : null,
  };
}

function parseSkill(value: unknown): PluginSkillTemplate | null {
  if (!isRecord(value)) return null;
  const configObjectId = readString(value.configObjectId);
  const title = readString(value.title);
  if (!configObjectId || !title) return null;
  return {
    configObjectId,
    denSkillId: readString(value.denSkillId),
    description: readString(value.description),
    status: readStatus(value.status),
    title,
  };
}

function parsePluginServerTemplates(payload: unknown): PluginServerTemplates {
  const item = isRecord(payload) && isRecord(payload.item) ? payload.item : {};
  return {
    instances: Array.isArray(item.instances) ? item.instances.flatMap((entry) => {
      const parsed = parseInstance(entry);
      return parsed ? [parsed] : [];
    }) : [],
    mcpTemplates: Array.isArray(item.mcpTemplates) ? item.mcpTemplates.flatMap((entry) => {
      const parsed = parseMcpTemplate(entry);
      return parsed ? [parsed] : [];
    }) : [],
    skills: Array.isArray(item.skills) ? item.skills.flatMap((entry) => {
      const parsed = parseSkill(entry);
      return parsed ? [parsed] : [];
    }) : [],
  };
}

export function usePluginServerTemplates(pluginId: string) {
  return useQuery({
    queryKey: pluginServerQueryKeys.detail(pluginId),
    queryFn: async (): Promise<PluginServerTemplates> => {
      const { response, payload } = await requestJson(
        `/v1/plugins/${encodeURIComponent(pluginId)}/server-templates`,
        { method: "GET" },
        15000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to load plugin server templates (${response.status}).`);
      }
      return parsePluginServerTemplates(payload);
    },
  });
}

export function useSetConfigObjectStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { configObjectId: string; pluginId: string; status: "active" | "inactive" }): Promise<typeof input> => {
      const { response, payload } = await requestJson(
        `/v1/config-objects/${encodeURIComponent(input.configObjectId)}/status`,
        { method: "PUT", body: JSON.stringify({ status: input.status }) },
        15000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to update skill status (${response.status}).`);
      }
      return input;
    },
    onSuccess: (input) => {
      queryClient.invalidateQueries({ queryKey: pluginServerQueryKeys.detail(input.pluginId) });
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.all });
    },
  });
}

export function useConfigurePluginServerInstance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConfigurePluginServerInstanceInput): Promise<void> => {
      const { response, payload } = await requestJson(
        `/v1/plugins/${encodeURIComponent(input.pluginId)}/server-instances`,
        {
          method: "POST",
          body: JSON.stringify({
            access: input.access,
            apiKey: input.apiKey,
            authType: input.authType,
            configObjectId: input.configObjectId,
            credentialMode: input.credentialMode,
            fieldValues: input.fieldValues,
            instanceLabel: input.instanceLabel,
            name: input.name,
            oauthClient: input.oauthClient,
            serverKey: input.serverKey,
          }),
        },
        15000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to configure MCP server (${response.status}).`);
      }
    },
    onSuccess: (_value, input) => {
      queryClient.invalidateQueries({ queryKey: pluginServerQueryKeys.detail(input.pluginId) });
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.all });
    },
  });
}

export function useRemovePluginServerInstance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { pluginId: string; instanceId: string; deleteConnection: boolean }): Promise<void> => {
      const deleteConnection = input.deleteConnection ? "true" : "false";
      const { response, payload } = await requestJson(
        `/v1/plugins/${encodeURIComponent(input.pluginId)}/server-instances/${encodeURIComponent(input.instanceId)}?deleteConnection=${deleteConnection}`,
        { method: "DELETE" },
        15000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to remove MCP server configuration (${response.status}).`);
      }
    },
    onSuccess: (_value, input) => {
      queryClient.invalidateQueries({ queryKey: pluginServerQueryKeys.detail(input.pluginId) });
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.all });
    },
  });
}
