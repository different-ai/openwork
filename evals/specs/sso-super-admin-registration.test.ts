import { expect } from "vitest";
import { denFetch, freshSession } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { inviteMember, localMysqlIsRunning, server, test } from "@openwork/testkit";

const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !localPlacement
  ? "super-admin SSO registration skipped — needs local placement without OPENWORK_EVAL_DEN_API_URL"
  : !mysqlOpen
    ? "super-admin SSO registration skipped — needs MySQL on 127.0.0.1:3306"
    : "a workspace super-admin can register SAML SSO without an internal authorization error";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

async function organizationId(admin: DenSession, organizationName: string): Promise<string> {
  const result = await denFetch(admin, "/v1/me/orgs", { headers: auth(admin) });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const organization = organizations.find((entry) => entry.name === organizationName);
  const id = organization && typeof organization.id === "string" ? organization.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the test organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function memberIdByEmail(admin: DenSession, orgId: string, email: string): Promise<string> {
  const result = await denFetch(admin, "/v1/org", {
    headers: { ...auth(admin), "x-openwork-org-id": orgId },
  });
  const members = isRecord(result.body) && Array.isArray(result.body.members)
    ? result.body.members.filter(isRecord)
    : [];
  const member = members.find((entry) => isRecord(entry.user) && entry.user.email === email);
  const id = member && typeof member.id === "string" ? member.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the super-admin membership failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

test.skipIf(!localPlacement || !mysqlOpen)(title, { timeout: 300_000 }, async ({ evidence, place }) => {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const organizationName = `Super-admin SSO ${runId}`;
  const password = "OpenWorkEval123!";

  await using den = await server({ place, org: { name: organizationName, members: {} } });
  const superAdmin = await inviteMember(den, "superAdmin", {
    email: `sso-super-admin.${runId}@openwork.test`,
    name: "SSO Super Admin",
    password,
  });
  const orgId = await organizationId(den.admin, organizationName);
  const memberId = await memberIdByEmail(den.admin, orgId, superAdmin.email);
  const memberSignIn = await denFetch(den.ref, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: superAdmin.email, password }),
  });
  const memberCookie = memberSignIn.response.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "";
  expect(memberCookie).toBeTruthy();

  const samlBody = JSON.stringify({
    issuer: "http://127.0.0.1/google-saml",
    domain: `super-admin-${runId}.test`,
    entryPoint: "https://accounts.google.com/o/saml2/idp?idpid=test",
    cert: "test-google-signing-certificate",
    audience: den.ref.apiUrl,
  });
  const memberRegistration = await denFetch(den.ref, "/v1/sso/saml", {
    method: "POST",
    headers: {
      authorization: `Bearer ${superAdmin.token}`,
      cookie: memberCookie,
      "x-openwork-org-id": orgId,
    },
    body: samlBody,
  });
  expect(memberRegistration.response.status, memberRegistration.text).toBe(403);

  const owner = await freshSession(den.admin);
  const promoted = await denFetch(owner, `/v1/members/${encodeURIComponent(memberId)}/role`, {
    method: "POST",
    headers: { ...auth(owner), "x-openwork-org-id": orgId },
    body: JSON.stringify({ role: "super-admin" }),
  });
  expect(promoted.response.status, promoted.text).toBe(200);

  const signedIn = await denFetch(den.ref, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: superAdmin.email, password }),
  });
  const sessionCookie = signedIn.response.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "";
  expect(sessionCookie).toBeTruthy();

  const registration = await denFetch(den.ref, "/v1/sso/saml", {
    method: "POST",
    headers: {
      authorization: `Bearer ${superAdmin.token}`,
      cookie: sessionCookie,
      "x-openwork-org-id": orgId,
    },
    body: samlBody,
  });

  expect(registration.response.status, registration.text).toBe(201);
  expect(isRecord(registration.body) && isRecord(registration.body.connection)).toBe(true);
  expect(registration.text).not.toMatch(/organization owner or admin/i);
  expect(registration.text).not.toMatch(/internal server error/i);
  evidence.recordAssertionEvidence(
    "A super-admin can save SAML settings through the real SSO registration route",
    `A member received HTTP ${memberRegistration.response.status}; after promotion to super-admin the same route returned HTTP ${registration.response.status} without either authorization mismatch error.`,
    registration.response.status === 201
      && memberRegistration.response.status === 403
      && !/organization owner or admin/i.test(registration.text)
      && !/internal server error/i.test(registration.text),
  );
});
