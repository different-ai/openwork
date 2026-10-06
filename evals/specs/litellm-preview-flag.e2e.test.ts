import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { spec } from "@openwork/testkit";
import { aiGatewayAdmin } from "../worlds/ai-gateway-admin.ts";

/**
 * LiteLLM is in preview behind the per-organization `litellm` capability.
 * An owner sees nothing of it until a platform admin turns it on in /admin;
 * then the LiteLLM tile and setup form appear. The flows themselves are proven
 * by litellm-gateway-provider.e2e.test.ts.
 */
const test = spec.world(aiGatewayAdmin, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

/** `features.litellm` on /v1/org. */
function litellmFlag(body: unknown): unknown {
  if (!body || typeof body !== "object" || !("features" in body)) return undefined;
  const features = body.features;
  return features && typeof features === "object" && "litellm" in features ? features.litellm : undefined;
}

test("LiteLLM stays hidden until a platform admin turns on the preview for the organization", async ({
  world, user, probe, step, evidence,
}) => {
  const owner = user.on(world.web);
  const providers = `${world.den.ref.webUrl}/dashboard/ai-gateway?tab=ai-providers`;
  const liteLlmSetup = `${world.den.ref.webUrl}/dashboard/ai-gateway/providers/new?provider=litellm`;

  await step("before: the provider catalog has no LiteLLM", async () => {
    await owner.see({ testId: "gateway-providers-empty" }, { timeoutMs: 90_000 });
    await owner.click({ testId: "gateway-provider-create" });
    await owner.see({ role: "heading", label: "Add a provider" }, { timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-provider-pick-anthropic" });
    await owner.notSee({ testId: "gateway-provider-pick-litellm" });
    const context = await probe.api(world.den.admin, "/v1/org");
    evidence.recordAssertionEvidence("the organization reports LiteLLM off", `GET /v1/org → features.litellm = ${String(litellmFlag(context.body))}`, litellmFlag(context.body) === false);
    expect(litellmFlag(context.body)).toBe(false);
    await owner.screenshot();
  });

  await step("before: the LiteLLM setup link explains it is in preview, with no form", async () => {
    await owner.navigate(liteLlmSetup);
    await owner.see({ testId: "litellm-preview-off" }, { timeoutMs: 60_000 });
    await owner.see({ text: "LiteLLM is in preview" });
    await owner.notSee({ testId: "litellm-connect" });
    const refused = await denFetch(world.den.admin, "/v1/inference-providers/litellm", {
      method: "POST",
      headers: { authorization: `Bearer ${world.den.admin.token}`, "x-openwork-org-id": world.orgId },
      body: JSON.stringify({ name: "LiteLLM", baseUrl: "https://litellm.example.com", mode: "org", apiKey: "sk-not-used-0000000000", allMembers: true }),
    });
    evidence.recordAssertionEvidence("the API refuses LiteLLM while the preview is off", `POST /v1/inference-providers/litellm → ${refused.response.status} ${refused.text.slice(0, 120)}`, refused.response.status === 404);
    expect(refused.response.status).toBe(404);
    expect(refused.text).toContain("feature_disabled");
    await owner.screenshot();
  });

  await step("a platform admin turns on the LiteLLM preview for this organization", async () => {
    // The platform admin's /admin switch, as the backoffice calls it.
    const enabled = await denFetch(world.den.admin, `/v1/admin/organizations/${world.orgId}/capabilities`, {
      method: "PUT",
      headers: { authorization: `Bearer ${world.den.admin.token}` },
      body: JSON.stringify({ capabilities: { litellm: true } }),
    });
    evidence.recordAssertionEvidence("the /admin capability write succeeds", `PUT /v1/admin/organizations/:id/capabilities {litellm: true} → ${enabled.response.status}`, enabled.response.ok);
    expect(enabled.response.status).toBe(200);
  });

  await step("after: LiteLLM appears in the catalog and opens its setup form", async () => {
    await owner.navigate(providers);
    await owner.click({ testId: "gateway-provider-create" });
    await owner.see({ testId: "gateway-provider-pick-litellm" }, { timeoutMs: 30_000 });
    await owner.screenshot();
    await owner.click({ testId: "gateway-provider-pick-litellm" });
    await owner.see({ testId: "gateway-provider-title" }, { text: "Add LiteLLM", timeoutMs: 30_000 });
    await owner.see({ testId: "litellm-base-url" });
    await owner.see({ testId: "litellm-connect" });
    await owner.notSee({ testId: "litellm-preview-off" });
    const context = await probe.api(world.den.admin, "/v1/org");
    evidence.recordAssertionEvidence("the organization reports LiteLLM on", `GET /v1/org → features.litellm = ${String(litellmFlag(context.body))}`, litellmFlag(context.body) === true);
    expect(litellmFlag(context.body)).toBe(true);
    await owner.screenshot();
  });
});
