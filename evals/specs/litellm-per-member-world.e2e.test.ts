import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { needs, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import {
  bootLiteLlmPerMember,
  LITELLM_WORLD_MODEL,
  LITELLM_WORLD_PROVIDER,
} from "../../worlds/litellm-per-member.ts";

const REPLY = "The database-backed per-member LiteLLM world is working.";
const requirements: TestNeeds = { optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["docker"] };
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `LiteLLM per-member world skipped — needs: ${missingRequirements.join(", ")}`
  : "one world boots Desktop, Den, and a reconciled per-member LiteLLM provider";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test.skipIf(missingRequirements.length > 0)(title, { timeout: 30 * 60_000 }, async ({ evidence, place }) => {
  needs(requirements);
  await using stack = new AsyncDisposableStack();
  const { provider: providerRuntime, den, desktop } = await bootLiteLlmPerMember(stack, place);

  expect(providerRuntime).toMatchObject({
    providerId: LITELLM_WORLD_PROVIDER,
    modelId: LITELLM_WORLD_MODEL,
    maxInputTokens: 128_000,
    maxOutputTokens: 16_384,
    metadataAction: "updated",
  });
  expect(providerRuntime.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);

  const listed = await denFetch(den.admin, "/v1/llm-providers?scope=manageable", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  });
  const providers = isRecord(listed.body) && Array.isArray(listed.body.llmProviders)
    ? listed.body.llmProviders.filter(isRecord)
    : [];
  const provider = providers.find((entry) => entry.id === providerRuntime.providerRecordId);
  const models = provider && Array.isArray(provider.models) ? provider.models.filter(isRecord) : [];
  const model = models.find((entry) => entry.id === LITELLM_WORLD_MODEL);
  expect(listed.response.status).toBe(200);
  expect(model).toMatchObject({
    config: { limit: { context: 128_000, input: 128_000, output: 16_384 } },
  });

  const connected = await denFetch(
    den.admin,
    `/v1/llm-providers/${encodeURIComponent(providerRuntime.providerRecordId)}/connect`,
    { headers: { authorization: `Bearer ${den.admin.token}` } },
  );
  const connectedProvider = isRecord(connected.body) && isRecord(connected.body.llmProvider)
    ? connected.body.llmProvider
    : null;
  const memberKey = connectedProvider && typeof connectedProvider.apiKey === "string"
    ? connectedProvider.apiKey
    : "";
  expect(connected.response.status).toBe(200);
  expect(connectedProvider).toMatchObject({ memberCredential: { state: "active" } });
  expect(memberKey).toMatch(/^sk-/);

  const response = await fetch(`${providerRuntime.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${memberKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: LITELLM_WORLD_MODEL,
      messages: [{ role: "user", content: "Verify the one-command world." }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const completion: unknown = await response.json();
  const choices = isRecord(completion) && Array.isArray(completion.choices)
    ? completion.choices.filter(isRecord)
    : [];
  const message = choices[0] && isRecord(choices[0].message) ? choices[0].message : null;
  expect(response.status).toBe(200);
  expect(message?.content).toBe(REPLY);
  expect(desktop.handle.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  evidence.recordAssertionEvidence(
    "One world starts a signed-in Desktop with a database-backed, metadata-synchronized per-member LiteLLM provider",
    `The world booted Desktop CDP, created Den provider ${providerRuntime.providerRecordId}, synchronized 128000/16384 limits, provisioned the admin member key, and returned the deterministic LiteLLM reply.`,
    response.status === 200
      && message?.content === REPLY
      && providerRuntime.metadataAction === "updated"
      && memberKey.startsWith("sk-"),
  );
});
