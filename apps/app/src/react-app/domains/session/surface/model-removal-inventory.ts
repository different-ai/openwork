import { z } from "zod";
import type { ModelRef } from "@/app/types";

export type ModelRemovalInventory = {
  models: Array<ModelRef & { title?: string }>;
  lockedModels: ModelRef[];
};

const identity = z.string().min(1).refine((value) => value === value.trim());
const legacyModel = z.object({ id: identity, name: z.string() });
const legacyInventory = z.object({
  llmProviders: z.array(z.object({
    id: identity,
    providerId: identity,
    name: z.string(),
    source: z.enum(["models_dev", "custom", "openwork"]),
    credentialMode: z.enum(["shared", "per_member"]).optional(),
    hasMyCredential: z.boolean().optional(),
    models: z.array(legacyModel),
  })),
});
const gatewayModel = z.object({
  id: identity.regex(/^gwm_.+/),
  name: z.string(),
  config: z.object({ id: identity }),
  upstreamModelId: identity,
  modelGroupId: identity,
  modelGroupName: z.string(),
  credentialSetId: identity,
  credentialSetName: z.string(),
}).refine((model) => model.config.id === model.id);
const gatewayInventory = z.object({
  inferenceProviders: z.array(z.object({
    id: identity.regex(/^ipr_.+/),
    providerId: identity,
    name: z.string(),
    source: z.literal("openwork_gateway"),
    credentialStatus: z.enum(["ready", "member_auth_required", "org_credential_missing"]),
    modelAssignmentsComplete: z.literal(true),
    models: z.array(gatewayModel),
    authorizationRequests: z.array(z.object({
      credentialSetId: identity,
      name: z.string(),
      authUrl: identity,
      models: z.array(gatewayModel),
    })),
  })),
});

export function parseModelRemovalInventory(
  legacyPayload: unknown,
  gatewayPayload: unknown,
): ModelRemovalInventory {
  const legacy = legacyInventory.parse(legacyPayload);
  const gateway = gatewayInventory.parse(gatewayPayload);
  const models: ModelRemovalInventory["models"] = [];
  const lockedModels: ModelRef[] = [];
  for (const provider of legacy.llmProviders) {
    const providerID = provider.source === "openwork" ? "openwork" : provider.id;
    for (const model of provider.models) {
      const ref = { providerID, modelID: model.id };
      models.push({ ...ref, title: model.name });
      if (provider.credentialMode === "per_member" && !provider.hasMyCredential) {
        lockedModels.push(ref);
      }
    }
  }
  for (const provider of gateway.inferenceProviders) {
    for (const model of provider.models) {
      models.push({ providerID: provider.id, modelID: model.id, title: model.name });
    }
    for (const request of provider.authorizationRequests) {
      for (const model of request.models) {
        const ref = { providerID: provider.id, modelID: model.id };
        models.push({ ...ref, title: model.name });
        lockedModels.push(ref);
      }
    }
  }
  return { models, lockedModels };
}
