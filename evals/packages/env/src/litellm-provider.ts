import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import type { LiteLlmHandle } from "./litellm.ts";

interface ExampleProvisionerModule {
  reconcileMemberKeys(input: {
    denApiUrl: string;
    denToken: string;
    orgId: string;
    providerId: string;
    liteLlmBaseUrl: string;
    liteLlmMasterKey: string;
    models: string[];
  }): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExampleProvisionerModule(value: unknown): value is ExampleProvisionerModule {
  return isRecord(value) && typeof value.reconcileMemberKeys === "function";
}

async function exampleProvisioner(): Promise<ExampleProvisionerModule> {
  const url = new URL("../../../../examples/litellm-per-member-keys/provision.mjs", import.meta.url).href;
  const imported: unknown = await import(url);
  if (!isExampleProvisionerModule(imported)) {
    throw new Error("The LiteLLM per-member example did not export reconcileMemberKeys.");
  }
  return imported;
}

function metadataResult(value: unknown, modelId: string): {
  action: "updated" | "unchanged";
  maxInputTokens: number;
  maxOutputTokens: number;
} {
  const metadata = isRecord(value) && isRecord(value.modelMetadata) ? value.modelMetadata : null;
  const models = metadata && Array.isArray(metadata.models) ? metadata.models.filter(isRecord) : [];
  const model = models.find((entry) => entry.id === modelId);
  if (!metadata
    || (metadata.action !== "updated" && metadata.action !== "unchanged")
    || !model
    || typeof model.maxInputTokens !== "number"
    || typeof model.maxOutputTokens !== "number") {
    throw new Error(`LiteLLM example reconciliation returned invalid metadata for model ${JSON.stringify(modelId)}.`);
  }
  return {
    action: metadata.action,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
  };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function liteLlmPerMemberProvider(
  admin: DenSession,
  input: {
    gateway: LiteLlmHandle;
    orgId: string;
    providerId: string;
    name?: string;
    envVar: string;
    modelId: string;
    modelName?: string;
  },
): Promise<{
  providerId: string;
  providerRecordId: string;
  baseUrl: string;
  modelId: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  metadataAction: "updated" | "unchanged";
}> {
  const provisioner = await exampleProvisioner();
  const name = input.name ?? input.providerId;
  const route = "/v1/llm-providers";
  const created = await denFetch(admin, route, {
    method: "POST",
    headers: {
      ...auth(admin.token),
      "content-type": "application/json",
      "x-openwork-org-id": input.orgId,
    },
    body: JSON.stringify({
      name,
      source: "custom",
      customConfig: {
        id: input.providerId,
        name,
        npm: "@ai-sdk/openai-compatible",
        env: [input.envVar],
        api: input.gateway.baseUrl,
        models: [{ id: input.modelId, name: input.modelName ?? input.modelId }],
      },
      credentialMode: "per_member",
      allMembers: true,
      memberIds: [],
      teamIds: [],
    }),
  });
  const createdProvider = isRecord(created.body) && isRecord(created.body.llmProvider)
    ? created.body.llmProvider
    : null;
  const providerRecordId = createdProvider && typeof createdProvider.id === "string"
    ? createdProvider.id
    : "";
  if (created.response.status !== 201 || !providerRecordId) {
    throw new Error(`POST ${route} failed for provider ${JSON.stringify(name)}: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
  }
  const reconciled = await provisioner.reconcileMemberKeys({
    denApiUrl: admin.apiUrl,
    denToken: admin.token,
    orgId: input.orgId,
    providerId: providerRecordId,
    liteLlmBaseUrl: input.gateway.baseUrl,
    liteLlmMasterKey: input.gateway.apiKey,
    models: [input.modelId],
  });
  const metadata = metadataResult(reconciled, input.modelId);
  return {
    providerId: input.providerId,
    providerRecordId,
    baseUrl: input.gateway.baseUrl,
    modelId: input.modelId,
    maxInputTokens: metadata.maxInputTokens,
    maxOutputTokens: metadata.maxOutputTokens,
    metadataAction: metadata.action,
  };
}
