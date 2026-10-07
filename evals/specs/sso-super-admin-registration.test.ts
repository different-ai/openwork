import { expect } from "vitest";
import { denFetch, freshSession } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { inviteMember, server, test } from "@openwork/testkit";

// Super-admin was merged into admin (migration 0133_deprecate_super_admin):
// registering SSO, which used to need super-admin, now needs the sso.manage
// permission that every admin holds by default.
const title = "a workspace admin can register SAML SSO, which used to need super-admin, without an internal authorization error";

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
    throw new Error(`Finding the admin membership failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

test(title, { timeout: 300_000 }, async ({ evidence, place }) => {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const organizationName = `Admin SSO ${runId}`;
  const password = "OpenWorkEval123!";

  await using den = await server({ place, org: { name: organizationName, members: {} } });
  const ssoAdmin = await inviteMember(den, "ssoAdmin", {
    email: `sso-admin.${runId}@openwork.test`,
    name: "SSO Admin",
    password,
  });
  const orgId = await organizationId(den.admin, organizationName);
  const memberId = await memberIdByEmail(den.admin, orgId, ssoAdmin.email);
  const memberSignIn = await denFetch(den.ref, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: ssoAdmin.email, password }),
  });
  const memberCookie = memberSignIn.response.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "";
  expect(memberCookie).toBeTruthy();

  const samlBody = JSON.stringify({
    issuer: "http://127.0.0.1/google-saml",
    domain: `sso-admin-${runId}.test`,
    entryPoint: "https://accounts.google.com/o/saml2/idp?idpid=test",
    cert: "test-google-signing-certificate",
    audience: den.ref.apiUrl,
  });
  const memberRegistration = await denFetch(den.ref, "/v1/sso/saml", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ssoAdmin.token}`,
      cookie: memberCookie,
      "x-openwork-org-id": orgId,
    },
    body: samlBody,
  });
  expect(memberRegistration.response.status, memberRegistration.text).toBe(403);
  expect(memberRegistration.body).toMatchObject({ error: "forbidden", requiredPermission: "sso.manage" });

  const owner = await freshSession(den.admin);
  const promoted = await denFetch(owner, `/v1/members/${encodeURIComponent(memberId)}/role`, {
    method: "POST",
    headers: { ...auth(owner), "x-openwork-org-id": orgId },
    body: JSON.stringify({ role: "admin" }),
  });
  expect(promoted.response.status, promoted.text).toBe(200);

  const signedIn = await denFetch(den.ref, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: ssoAdmin.email, password }),
  });
  const sessionCookie = signedIn.response.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "";
  expect(sessionCookie).toBeTruthy();

  const registration = await denFetch(den.ref, "/v1/sso/saml", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ssoAdmin.token}`,
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
    "An admin can save SAML settings through the real SSO registration route",
    `A member received HTTP ${memberRegistration.response.status} naming the missing permission ${String(isRecord(memberRegistration.body) ? memberRegistration.body.requiredPermission : "")}; after promotion to admin the same route returned HTTP ${registration.response.status} without either authorization mismatch error.`,
    registration.response.status === 201
      && memberRegistration.response.status === 403
      && !/organization owner or admin/i.test(registration.text)
      && !/internal server error/i.test(registration.text),
  );
});
