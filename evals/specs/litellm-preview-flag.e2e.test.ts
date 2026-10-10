import { expect } from "vitest";
import { eventually, spec } from "@openwork/testkit";
import { aiGatewayAdmin } from "../worlds/ai-gateway-admin.ts";

/**
 * LiteLLM is behind the `litellm` feature (packages/features), off by default.
 * An owner sees nothing of it until a platform admin ticks it in /admin; then
 * the LiteLLM tile and setup form appear. Locally the world's owner is also the
 * platform admin. The API refusal and the flows themselves are proven by
 * litellm-gateway-provider.e2e.test.ts.
 */
const test = spec.world(aiGatewayAdmin, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

function organizationSlug(body: unknown): string {
  if (!body || typeof body !== "object" || !("organization" in body)) return "";
  const organization = body.organization;
  return organization && typeof organization === "object" && "slug" in organization && typeof organization.slug === "string" ? organization.slug : "";
}

/** `litellm` inside one map of a response: `features` on /v1/org, `capabilities` on the admin API. */
function litellmFlag(body: unknown, field: "features" | "capabilities"): unknown {
  if (!body || typeof body !== "object" || !(field in body)) return undefined;
  const map: unknown = Reflect.get(body, field);
  return map && typeof map === "object" && "litellm" in map ? map.litellm : undefined;
}

test("LiteLLM stays hidden until a platform admin turns on the preview for the organization", async ({
  world, user, probe, step, evidence,
}) => {
  const owner = user.on(world.web);
  const providers = `${world.den.ref.webUrl}/dashboard/ai-gateway?tab=ai-providers`;
  const liteLlmSetup = `${world.den.ref.webUrl}/dashboard/ai-gateway/providers/new?provider=litellm`;
  const adminCapabilities = `/v1/admin/organizations/${world.orgId}/capabilities`;

  await step("before: the provider catalog has no LiteLLM", async () => {
    await owner.see({ testId: "gateway-providers-empty" }, { timeoutMs: 90_000 });
    await owner.click({ testId: "gateway-provider-create" });
    await owner.see({ role: "heading", label: "Add a provider" }, { timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-provider-pick-anthropic" });
    await owner.notSee({ testId: "gateway-provider-pick-litellm" });
    const context = await probe.api(world.den.admin, "/v1/org");
    evidence.recordAssertionEvidence("the organization reports LiteLLM off", `GET /v1/org → features.litellm = ${String(litellmFlag(context.body, "features"))}`, litellmFlag(context.body, "features") === false);
    expect(litellmFlag(context.body, "features")).toBe(false);
    await owner.screenshot();
  });

  await step("before: the LiteLLM setup link explains it is in preview, with no form", async () => {
    await owner.navigate(liteLlmSetup);
    await owner.see({ testId: "litellm-preview-off" }, { timeoutMs: 60_000 });
    await owner.see({ text: "LiteLLM is in preview" });
    await owner.notSee({ testId: "litellm-connect" });
    await owner.screenshot();
  });

  await step("a platform admin ticks LiteLLM for this organization in /admin", async () => {
    const slug = organizationSlug((await probe.api(world.den.admin, "/v1/org")).body);
    expect(slug).not.toBe("");
    await owner.navigate(`${world.den.ref.webUrl}/admin`);
    await owner.see({ role: "button", label: /^Organizations/ }, { timeoutMs: 60_000 });
    await owner.click({ role: "button", label: /^Organizations/ });
    await owner.type({ placeholder: "Org name, slug, or id" }, slug);
    await owner.see({ testId: `admin-org-row-${slug}` }, { timeoutMs: 30_000 });
    await owner.click({ testId: "admin-capability-litellm" });
    const saved = await eventually(async () => {
      const value = litellmFlag((await probe.api(world.den.admin, adminCapabilities)).body, "capabilities");
      return value === true ? value : false;
    }, { within: 30_000, intervalMs: 500, label: "the litellm capability saved" });
    evidence.recordAssertionEvidence("the /admin checkbox turns the capability on", `After ticking "AI Gateway: LiteLLM", GET ${adminCapabilities} → litellm = ${String(saved)}`, saved === true);
    expect(saved).toBe(true);
    await owner.screenshot();
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
    evidence.recordAssertionEvidence("the organization reports LiteLLM on", `GET /v1/org → features.litellm = ${String(litellmFlag(context.body, "features"))}`, litellmFlag(context.body, "features") === true);
    expect(litellmFlag(context.body, "features")).toBe(true);
    await owner.screenshot();
  });
});
