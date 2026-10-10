import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { aiGatewayCloudSignIn } from "../worlds/ai-gateway-cloud-sign-in.ts";

const test = spec.world(aiGatewayCloudSignIn, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

// Placeholder IAM Identity Center and Entra ID values: Den stores them without calling AWS or Microsoft.
const AWS_SSO = { startUrl: "https://d-9067eval00.awsapps.com/start", region: "us-east-1", accountId: "123456789012", roleName: "BedrockInference" };
const TENANT_ID = "6f0e3a5e-1b2c-4d3e-8f90-0a1b2c3d4e5f";
const CLIENT_ID = "0b6c2d1e-7f8a-4b9c-a0d1-e2f3a4b5c6d7";
const CLIENT_SECRET = "eval~entra-client-secret-not-real";

function providers(body: unknown): Array<Record<string, unknown>> {
  const list = body && typeof body === "object" && "inferenceProviders" in body ? body.inferenceProviders : [];
  return Array.isArray(list) ? list.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null) : [];
}

function firstSet(provider: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const sets = provider?.credentialSets;
  const first: unknown = Array.isArray(sets) ? sets[0] : null;
  return first && typeof first === "object" ? Object.fromEntries(Object.entries(first)) : null;
}

test("an owner lets each person sign in to Amazon Bedrock with AWS and to Microsoft Foundry with Microsoft, and a teammate is sent to AWS to sign in", async ({
  world, user, probe, seed, step, evidence,
}) => {
  const owner = user.on(world.web);
  const teammate = user.on(world.memberWeb);
  const manageable = "/v1/inference-providers?scope=manageable";

  await step("before: Amazon Bedrock offers only a shared key and Microsoft Foundry is not in the catalog", async () => {
    await owner.see({ testId: "gateway-providers-empty" }, { timeoutMs: 90_000 });
    await owner.click({ testId: "gateway-provider-create" });
    await owner.see({ role: "heading", label: "Add a provider" }, { timeoutMs: 30_000 });
    await owner.type({ testId: "gateway-provider-catalog-filter" }, "Foundry");
    await owner.notSee({ testId: "gateway-provider-pick-microsoft-foundry" }, { timeoutMs: 10_000 });
    await owner.screenshot();
    await owner.type({ testId: "gateway-provider-catalog-filter" }, "Bedrock", { replace: true });
    await owner.click({ testId: "gateway-provider-pick-amazon-bedrock" });
    await owner.see({ testId: "gateway-provider-title" }, { text: "Add Amazon Bedrock", timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-member-sign-in-locked" }, { text: "AWS sign-in isn't turned on for your organization yet. Ask an OpenWork platform admin to turn it on." });
    const locked = (await probe.on(world.web).dom('[data-testid="gateway-member-sign-in-locked"]')).elements;
    expect(locked).toHaveLength(1);
    expect(locked[0]?.text).toContain("OpenWork platform admin");
    const disabled = (await probe.on(world.web).dom('[role="radio"]:disabled')).elements;
    expect(disabled).toHaveLength(1);
    evidence.recordAssertionEvidence("the locked AWS sign-in names the person who can enable it", `${locked[0]?.text}; member sign-in remains disabled and Microsoft Foundry is absent from the catalog.`, locked[0]?.text.includes("OpenWork platform admin") === true && disabled.length === 1);
    await owner.screenshot();
  });

  await step("a platform admin turns on AWS and Microsoft sign-in for the organization", async () => {
    const result = await seed.api(world.den.admin, `/v1/admin/organizations/${world.orgId}/capabilities`, {
      method: "PUT", body: JSON.stringify({ capabilities: { gatewayCloudSignIn: true } }),
    });
    evidence.recordAssertionEvidence("the feature is on for Acme Studio", `PUT capabilities → ${result.response.status}`, result.response.ok);
    expect(result.response.ok).toBe(true);
    await owner.reload();
    await owner.see({ testId: "gateway-provider-title" }, { text: "Add Amazon Bedrock", timeoutMs: 30_000 });
    await owner.notSee({ testId: "gateway-member-sign-in-locked" });
    expect((await probe.on(world.web).dom('[role="radio"]:disabled')).elements).toHaveLength(0);
    await owner.screenshot();
  });

  await step("the owner adds Amazon Bedrock where each person signs in with IAM Identity Center, without any AWS keys", async () => {
    await owner.type({ testId: "gateway-setting-region" }, "us-west-2");
    await owner.click({ role: "radio", label: "Each member signs in" });
    await owner.type({ testId: "gateway-aws-sso-startUrl" }, AWS_SSO.startUrl);
    await owner.type({ testId: "gateway-aws-sso-region" }, AWS_SSO.region);
    await owner.type({ testId: "gateway-aws-sso-accountId" }, AWS_SSO.accountId);
    await owner.type({ testId: "gateway-aws-sso-roleName" }, AWS_SSO.roleName);
    await owner.notSee({ testId: "gateway-aws-access-key-id" });
    await owner.screenshot();
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ testId: "gateway-provider-open" }, { timeoutMs: 60_000 });
    const after = await probe.api(world.den.admin, manageable);
    const bedrock = providers(after.body).find((entry) => entry.providerId === "amazon-bedrock");
    const set = firstSet(bedrock);
    evidence.recordAssertionEvidence(
      "Amazon Bedrock is saved for member sign-in with the Identity Center account and permission set",
      `credentialMode ${String(set?.credentialMode)}, configured ${String(set?.configured)}, awsSso ${JSON.stringify(set?.awsSso)}`,
      set?.credentialMode === "member" && set?.configured === true && JSON.stringify(set?.awsSso) === JSON.stringify(AWS_SSO),
    );
    expect(set?.awsSso).toEqual(AWS_SSO);
  });

  await step("the owner adds Microsoft Foundry where each person signs in with Entra ID, and gets the redirect URI to register", async () => {
    await owner.click({ testId: "gateway-provider-create" });
    await owner.see({ role: "heading", label: "Add a provider" }, { timeoutMs: 30_000 });
    await owner.type({ testId: "gateway-provider-catalog-filter" }, "Foundry");
    await owner.click({ testId: "gateway-provider-pick-microsoft-foundry" });
    await owner.see({ testId: "gateway-provider-title" }, { text: "Add Microsoft Foundry (Claude)", timeoutMs: 30_000 });
    await owner.type({ testId: "gateway-setting-resourceName" }, "acme-foundry");
    await owner.click({ role: "radio", label: "Each member signs in" });
    await owner.type({ testId: "gateway-oauth-tenant-id" }, TENANT_ID);
    await owner.type({ testId: "gateway-oauth-client-id" }, CLIENT_ID);
    await owner.type({ testId: "gateway-oauth-client-secret" }, CLIENT_SECRET);
    await owner.click({ testId: "gateway-provider-save" });
    await owner.click({ role: "link", label: "Manage Microsoft Foundry (Claude)" });
    await owner.see({ text: "Redirect URI" }, { timeoutMs: 60_000 });
    const after = await probe.api(world.den.admin, manageable);
    const foundry = providers(after.body).find((entry) => entry.providerId === "microsoft-foundry");
    const set = firstSet(foundry);
    const leaked = after.text.includes(CLIENT_SECRET);
    const callback = String(foundry?.oauthCallbackUrl ?? "");
    evidence.recordAssertionEvidence(
      "Microsoft Foundry is saved for member sign-in, shows the redirect URI, and the client secret never comes back",
      `resourceName ${JSON.stringify(foundry?.settings)}, credentialMode ${String(set?.credentialMode)}, tenant ${String(set?.oauthTenantId)}, secret saved ${String(set?.hasOauthClientSecret)}, redirect URI ${callback}, response contains the secret: ${leaked}`,
      set?.credentialMode === "member" && set?.oauthTenantId === TENANT_ID && set?.hasOauthClientSecret === true && callback.endsWith("/v1/inference-providers/oauth/callback") && !leaked,
    );
    await owner.see({ text: callback });
    expect(leaked).toBe(false);
    await owner.screenshot();
  });

  await step("after: a teammate who has not signed in is sent to AWS with OpenWork's connect page", async () => {
    const usable = await probe.api(world.teammate, "/v1/inference-providers");
    const bedrock = providers(usable.body).find((entry) => entry.providerId === "amazon-bedrock");
    const start = await seed.api(world.teammate, `/v1/inference-providers/${String(bedrock?.id)}/oauth/start`, {
      headers: { accept: "application/json", "x-openwork-org-id": world.orgId },
    });
    const authUrl = start.body && typeof start.body === "object" && "authUrl" in start.body ? String(start.body.authUrl) : "";
    evidence.recordAssertionEvidence(
      "the teammate needs to sign in and gets a connect link",
      `credentialStatus ${String(bedrock?.credentialStatus)}; oauth/start → ${start.response.status}`,
      bedrock?.credentialStatus === "member_auth_required" && start.response.ok && authUrl.includes("/gateway/connect"),
    );
    expect(authUrl).toContain("/gateway/connect");
    await teammate.navigate(authUrl);
    await teammate.see({ role: "heading", label: "Sign in to AWS" }, { timeoutMs: 60_000 });
    await teammate.see({ testId: "gateway-connect-aws-start" }, { text: "Continue to AWS" });
    await teammate.screenshot();
  });

  await step("a teammate can sign in to use models but still cannot configure cloud sign-in", async () => {
    await teammate.navigate(`${world.den.ref.webUrl}/dashboard/ai-gateway/providers/new?provider=amazon-bedrock`);
    await teammate.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
    await teammate.notSee({ testId: "gateway-provider-save" }, { timeoutMs: 30_000 });
    await teammate.notSee({ testId: "gateway-aws-sso-startUrl" });
    await teammate.notSee({ testId: "gateway-aws-access-key-id" });
    const denied = await probe.api(world.teammate, manageable);
    expect(denied.response.status).toBe(403);
    evidence.recordAssertionEvidence("enabling cloud sign-in preserves the administration boundary", `The teammate sees no sign-in configuration or Save; manageable providers returns HTTP ${denied.response.status}.`, denied.response.status === 403);
    await teammate.screenshot();
  });
});
