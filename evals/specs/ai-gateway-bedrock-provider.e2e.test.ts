import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { aiGatewayAdmin } from "../worlds/ai-gateway-admin.ts";

const test = spec.world(aiGatewayAdmin, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

// Placeholder AWS keys: den-api stores them without calling AWS, and this journey never reaches the gateway.
const ACCESS_KEY_ID = "AKIAEVALNOTAREALKEY1";
const SECRET_ACCESS_KEY = "eval-bedrock-secret-not-a-real-key";

function providers(body: unknown): Array<Record<string, unknown>> {
  const list = body && typeof body === "object" && "inferenceProviders" in body ? body.inferenceProviders : [];
  return Array.isArray(list) ? list.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null) : [];
}

test("an owner connects Amazon Bedrock with AWS keys and reuses them for Bedrock's OpenAI models without pasting them again", async ({
  world, user, probe, step, evidence,
}) => {
  const owner = user.on(world.web);
  const manageable = "/v1/inference-providers?scope=manageable";

  await step("before: AI Gateway is empty and the catalog offers Amazon Bedrock and Amazon Bedrock (OpenAI)", async () => {
    await owner.see({ testId: "gateway-providers-empty" }, { timeoutMs: 90_000 });
    await owner.click({ testId: "gateway-provider-create" });
    await owner.see({ role: "heading", label: "Add a provider" }, { timeoutMs: 30_000 });
    await owner.type({ testId: "gateway-provider-catalog-filter" }, "Bedrock");
    await owner.see({ testId: "gateway-provider-pick-amazon-bedrock" }, { text: /^Amazon Bedrock\s+\d+ models$/, timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-provider-pick-amazon-bedrock-mantle" }, { text: /^Amazon Bedrock \(OpenAI\)\s+\d+ models$/ });
    const before = await probe.api(world.den.admin, manageable);
    evidence.recordAssertionEvidence("no providers yet", `GET ${manageable} → ${before.response.status}, ${providers(before.body).length} providers`, providers(before.body).length === 0);
    await owner.screenshot();
  });

  await step("the owner adds Amazon Bedrock with an AWS region and access keys", async () => {
    await owner.click({ testId: "gateway-provider-pick-amazon-bedrock" });
    await owner.see({ testId: "gateway-provider-title" }, { text: "Add Amazon Bedrock", timeoutMs: 30_000 });
    await owner.type({ testId: "gateway-setting-region" }, "us-east-1");
    await owner.type({ testId: "gateway-aws-access-key-id" }, ACCESS_KEY_ID);
    await owner.type({ testId: "gateway-aws-secret-access-key" }, SECRET_ACCESS_KEY);
    await owner.screenshot();
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ testId: "gateway-provider-open" }, { timeoutMs: 60_000 });
    await owner.see({ text: "Ready" });
    const after = await probe.api(world.den.admin, manageable);
    const bedrock = providers(after.body).find((entry) => entry.providerId === "amazon-bedrock");
    evidence.recordAssertionEvidence("Amazon Bedrock is saved with shared AWS keys", `providerId ${String(bedrock?.providerId)}, credentialStatus ${String(bedrock?.credentialStatus)}, settings ${JSON.stringify(bedrock?.settings)}`, bedrock?.credentialStatus === "ready");
    expect(bedrock?.credentialStatus).toBe("ready");
  });

  await step("adding Amazon Bedrock (OpenAI) offers the saved keys, so the owner only enters a region", async () => {
    await owner.click({ testId: "gateway-provider-create" });
    await owner.see({ role: "heading", label: "Add a provider" }, { timeoutMs: 30_000 });
    await owner.type({ testId: "gateway-provider-catalog-filter" }, "Bedrock");
    await owner.click({ testId: "gateway-provider-pick-amazon-bedrock-mantle" });
    await owner.see({ testId: "gateway-provider-title" }, { text: "Add Amazon Bedrock (OpenAI)", timeoutMs: 30_000 });
    await owner.see({ text: "Use AWS keys you already saved" }, { timeoutMs: 30_000 });
    await owner.click({ testId: "gateway-aws-reuse-keys" });
    await owner.see({ text: "Using the AWS keys saved for Amazon Bedrock" });
    await owner.notSee({ testId: "gateway-aws-secret-access-key" });
    await owner.type({ testId: "gateway-setting-region" }, "us-west-2");
    await owner.screenshot();
  });

  await step("after: both providers are ready for everyone and the AWS keys never came back to the browser", async () => {
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ testId: "gateway-provider-audience" }, { text: "Everyone", timeoutMs: 60_000 });
    await owner.see({ role: "link", label: "Manage Amazon Bedrock (OpenAI)" }, { timeoutMs: 30_000 });
    const after = await probe.api(world.den.admin, manageable);
    const saved = providers(after.body);
    const mantle = saved.find((entry) => entry.providerId === "amazon-bedrock-mantle");
    const leaked = after.text.includes(SECRET_ACCESS_KEY) || after.text.includes(ACCESS_KEY_ID);
    evidence.recordAssertionEvidence(
      "Bedrock (OpenAI) reuses the saved keys server-side and no key is returned",
      `${saved.length} providers; amazon-bedrock-mantle credentialStatus ${String(mantle?.credentialStatus)}; response contains the AWS keys: ${leaked}`,
      saved.length === 2 && mantle?.credentialStatus === "ready" && !leaked,
    );
    expect(saved).toHaveLength(2);
    expect(mantle?.credentialStatus).toBe("ready");
    expect(leaked).toBe(false);
    await owner.screenshot();
  });
});
