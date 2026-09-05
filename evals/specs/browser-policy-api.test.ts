import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { server, test } from "@openwork/testkit";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected a JSON object.");
  return value;
}

// The API is available before desktop adoption: an administrator can provision
// browser permissions, while existing clients keep using the same request keys.
test("an administrator provisions browser policy through the API while existing client requests remain compatible", { timeout: 300_000 }, async ({ evidence, place }) => {
  const name = `Browser policy API ${Date.now()}`;
  await using den = await server({
    place, web: false,
    org: { name, members: { reader: {} } },
    env: { DEN_PLAN_GATING_ENABLED: "false" },
  });
  const organizations = await denFetch(den.admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${den.admin.token}` } });
  expect(organizations.response.status, organizations.text).toBe(200);
  const entries = record(organizations.body).orgs;
  if (!Array.isArray(entries)) throw new Error("Missing organizations.");
  const organization = entries.map(record).find((entry) => entry.name === name);
  if (!organization || typeof organization.id !== "string") throw new Error("Missing the fixture organization.");
  const organizationId = organization.id;
  async function request(identity: DenSession, path: string, init?: RequestInit) {
    return denFetch(identity, path, {
      ...init,
      headers: { authorization: `Bearer ${identity.token}`, "x-openwork-org-id": organizationId },
      signal: AbortSignal.timeout(30_000),
    });
  }
  async function config() {
    const result = await request(den.members.reader, "/v1/me/desktop-config");
    expect(result.response.status, result.text).toBe(200);
    return record(result.body);
  }
  const initial = await config();
  expect(initial).toMatchObject({ allowBrowserLoginImport: false, allowedBrowserHosts: ["*"], allowBuiltInExtensions: true });
  evidence.recordAssertionEvidence("The additive policy API defaults preserve existing browser access", "The member's existing desktop-config endpoint returned built-in browser access, an explicit unrestricted host policy, and login import disabled by default.", true);

  const listed = await request(den.admin, "/v1/desktop-policies");
  expect(listed.response.status, listed.text).toBe(200);
  const policies = record(listed.body).desktopPolicies;
  if (!Array.isArray(policies)) throw new Error("Missing desktop policies.");
  const policy = policies.map(record).find((entry) => entry.isDefault === true);
  if (!policy || typeof policy.id !== "string") throw new Error("Missing the default policy.");
  const path = `/v1/desktop-policies/${policy.id}`;
  async function update(value: Record<string, unknown>) {
    const result = await request(den.admin, path, { method: "PATCH", body: JSON.stringify({ policyName: "Default desktop policy", policy: value }) });
    expect(result.response.status, result.text).toBe(200);
    return record(record(result.body).desktopPolicy);
  }

  const stored = await update({ allowBrowserLoginImport: true, allowedBrowserHosts: ["project.example"], allowBuiltInExtensions: true });
  expect(stored.policy).toMatchObject({ allowBrowserLoginImport: true, allowedBrowserHosts: ["project.example"] });
  expect(await config()).toMatchObject({ allowBrowserLoginImport: true, allowedBrowserHosts: ["project.example"], allowBuiltInExtensions: true });
  evidence.recordAssertionEvidence("An administrator's browser grant reaches the member through the existing API", "The policy update persisted the explicit import grant and project.example allowlist. A separate member GET returned both effective values and preserved the existing built-in extension permission.", true);

  const refused = await request(den.members.reader, path, { method: "PATCH", body: JSON.stringify({ policyName: "Default desktop policy", policy: { allowBrowserLoginImport: false, allowedBrowserHosts: ["*"] } }) });
  expect(refused.response.status, refused.text).toBe(403);
  expect(await config()).toMatchObject({ allowBrowserLoginImport: true, allowedBrowserHosts: ["project.example"] });
  evidence.recordAssertionEvidence("A member cannot change the organization's browser permissions", "The member's update returned HTTP 403. A subsequent member config read retained the administrator's import grant and host restriction.", true);

  await update({ allowBrowserLoginImport: false, allowedBrowserHosts: null });
  expect(await config()).toMatchObject({ allowBrowserLoginImport: false, allowedBrowserHosts: ["*"] });
  evidence.recordAssertionEvidence("Administrators can revoke import and explicitly clear a website restriction", "Updating the policy to deny import and clear the host list returned an effective false grant and explicit unrestricted hosts.", true);

  await update({ allowZenModel: false });
  const legacy = await config();
  expect(legacy).toMatchObject({ allowZenModel: false, allowBuiltInExtensions: true, allowBrowserLoginImport: false, allowedBrowserHosts: ["*"] });
  for (const key of ["allowCustomProviders", "allowMultipleWorkspaces", "allowControlSettings", "allowManageExtensions", "allowAlphaUpdates", "showWelcomePage"]) {
    expect(legacy[key], key).toBe(initial[key]);
  }
  evidence.recordAssertionEvidence("Existing clients can still update policy without sending the new fields", "An update containing only the existing allowZenModel flag succeeded. That flag changed, the other existing flags retained their values, and the new fields used safe defaults without becoming required request fields.", true);
});
