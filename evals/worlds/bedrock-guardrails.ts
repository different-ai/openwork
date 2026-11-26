import type { Seed } from "@openwork/env";
import { gatewayEnvironment, startAcmeGateway } from "../../worlds/lib/acme-gateway.ts";
import { isRecord } from "./library.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

export const BEDROCK_NAME = "Bedrock guardrail proof";

export function bedrockGuardrailsOffWorld(seed: Seed) {
  return bedrockGuardrailsWorld(seed, false);
}

export function bedrockGuardrailsOnWorld(seed: Seed) {
  return bedrockGuardrailsWorld(seed, true);
}

/** A disposable cloud Den and real Gateway; dummy AWS keys never call AWS. */
async function bedrockGuardrailsWorld(seed: Seed, enabled: boolean) {
  const stack = new AsyncDisposableStack();
  try {
    const gateway = await gatewayEnvironment("https://bedrock-runtime.us-east-1.amazonaws.com");
    const env = { ...gateway.env, DEN_DEPLOYMENT: "cloud" };
    const den = stack.use(await seed.den({ env, org: { name: "Guardrail proof", admin: { name: "Gateway owner" } } }));
    if (!den.database) throw new Error("The Bedrock proof needs its disposable local database.");
    await startAcmeGateway(stack, den.database.url, { baseUrl: gateway.baseUrl, env });
    if (enabled) await enableOrganizationCapabilities(seed, den.admin, { bedrockGuardrails: true });
    const created = await seed.api(den.admin, "/v1/inference-providers", {
      method: "POST",
      body: JSON.stringify({
        name: BEDROCK_NAME, providerId: "amazon-bedrock", modelIds: [],
        settings: { region: "us-east-1" },
        credential: { kind: "aws_keys", secret: JSON.stringify({ accessKeyId: "proof-access-key", secretAccessKey: "proof-secret-key" }) },
        allMembers: true,
      }),
    });
    const provider = isRecord(created.body) && isRecord(created.body.inferenceProvider) ? created.body.inferenceProvider : null;
    if (created.response.status !== 201 || typeof provider?.id !== "string") throw new Error(`Staging Bedrock failed: HTTP ${created.response.status} ${created.text.slice(0, 400)}`);
    const providerPath = `/v1/inference-providers/${provider.id}`;
    const startPath = `/dashboard/ai-gateway/providers/${provider.id}`;
    const web = await seed.web({ den, signedInAs: den.admin, startPath, headless: true, viewport: { width: 1440, height: 1100 } });
    return {
      den, web, providerPath, editorUrl: new URL(startPath, den.ref.webUrl).href,
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
