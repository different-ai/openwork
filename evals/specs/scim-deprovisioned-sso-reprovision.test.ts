import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenRef } from "@openwork/behaviors";
import { startMockIdpLab } from "@openwork/labs";
import type { StartedMockIdpLab } from "@openwork/labs";
import { createAdmin, eventually, inviteMember, queryDenDatabase, server, test } from "@openwork/testkit";
import type { Den } from "@openwork/testkit";
import { enableScimFixtureSso } from "./helpers/scim-fixture.ts";

// One IdP-shaped lifecycle that Okta's Provision Users + SSO combination
// produces in the field: SCIM deactivates a member, the person still tries the
// SSO link, and the IdP later re-provisions them. Den must refuse the sign-in
// without leaving a ghost identity behind, or the re-provision collides.
const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const SCIM_BASE_PATH = "/api/auth/scim/v2";
const DEPROVISIONED_MESSAGE = "This user was deprovisioned by SCIM. Reactivate them in the identity provider before signing in.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function recordsField(value: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return [];
  return value[key].filter(isRecord);
}

function orgHasJoinedMember(body: unknown, email: string): boolean {
  return recordsField(body, "members").some((member) => {
    const user = member.user;
    return typeof member.userId === "string" && isRecord(user) && user.email === email;
  });
}

function orgMemberRole(body: unknown, email: string): string | null {
  const member = recordsField(body, "members").find((entry) => isRecord(entry.user) && entry.user.email === email);
  return stringField(member, "role");
}

async function scimFetch(
  ref: DenRef,
  path: string,
  bearer: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: unknown; text: string }> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bearer}`);
  headers.set("accept", "application/scim+json, application/json");
  headers.set("content-type", "application/scim+json");
  const response = await fetch(`${ref.apiUrl.replace(/\/+$/, "")}${SCIM_BASE_PATH}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text.trim() ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

// Drives Den's real OIDC sign-in the way a browser would: Den mints the
// authorization URL and state cookie, the IdP redirects back with a code, and
// the callback is delivered to Den with that state cookie. The IdP's callback
// target is Den's public auth origin; the API host serves the same route.
async function attemptSsoSignIn(den: Den, email: string) {
  const start = await denFetch(den.ref, "/api/auth/sign-in/sso", {
    method: "POST",
    body: JSON.stringify({ email, callbackURL: `${den.ref.webUrl}/` }),
  });
  const authorizationUrl = stringField(start.body, "url");
  if (!start.response.ok || !authorizationUrl) {
    throw new Error(`SSO sign-in start failed: HTTP ${start.response.status} ${start.text.slice(0, 500)}`);
  }
  const stateCookie = start.response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]?.trim() ?? "").filter(Boolean).join("; ");
  const idpRedirect = await fetch(authorizationUrl, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const idpLocation = idpRedirect.headers.get("location");
  if (idpRedirect.status !== 302 || !idpLocation) {
    throw new Error(`Mock IdP did not redirect back to Den: HTTP ${idpRedirect.status} ${(await idpRedirect.text()).slice(0, 300)}`);
  }
  const callbackUrl = new URL(idpLocation);
  const apiOrigin = new URL(den.ref.apiUrl);
  callbackUrl.protocol = apiOrigin.protocol;
  callbackUrl.host = apiOrigin.host;
  const callback = await fetch(callbackUrl, {
    redirect: "manual",
    headers: { cookie: stateCookie },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await callback.text();
  let body: unknown = text;
  try {
    body = text.trim() ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const sessionCookieIssued = callback.headers.getSetCookie().some((cookie) => /session_token=[^;]+/.test(cookie) && !/session_token=;/.test(cookie));
  return { response: callback, body, text, sessionCookieIssued };
}

interface JourneyOrg {
  den: Den;
  organizationId: string;
  adminHeaders: Record<string, string>;
  managedEmail: string;
  controlEmail: string;
  controlRole: string;
  mode: "multi_org" | "single_org";
}

async function registerEnabledOidcSso(den: Den, idp: StartedMockIdpLab): Promise<{ organizationId: string; adminHeaders: Record<string, string> }> {
  const organizationResult = await denFetch(den.ref, "/v1/org", { headers: { authorization: `Bearer ${den.admin.token}` } });
  const organizationId = isRecord(organizationResult.body) ? stringField(organizationResult.body.organization, "id") : null;
  if (!organizationResult.response.ok || !organizationId) {
    throw new Error(`Organization lookup failed: HTTP ${organizationResult.response.status} ${organizationResult.text.slice(0, 500)}`);
  }
  // Security configuration routes need a cookie session; capture it before SSO
  // is enabled because single-org Den then routes every password request to SSO.
  const adminSignIn = await denFetch(den.ref, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: den.admin.email, password: den.admin.password }),
  });
  const sessionCookie = adminSignIn.response.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "";
  if (!adminSignIn.response.ok || !sessionCookie) {
    throw new Error(`Admin cookie sign-in failed: HTTP ${adminSignIn.response.status} ${adminSignIn.text.slice(0, 500)}`);
  }
  const adminHeaders = {
    authorization: `Bearer ${den.admin.token}`,
    cookie: sessionCookie,
    "x-openwork-org-id": organizationId,
  };
  const registration = idp.registration();
  const sso = await denFetch(den.ref, "/v1/sso/oidc", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      issuer: registration.issuer,
      domain: registration.domain,
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      scopes: registration.scopes,
      skipDiscovery: registration.skipDiscovery,
      authorizationEndpoint: registration.authorizationEndpoint,
      tokenEndpoint: registration.tokenEndpoint,
      jwksEndpoint: registration.jwksEndpoint,
      userInfoEndpoint: registration.userInfoEndpoint,
      tokenEndpointAuthentication: registration.tokenEndpointAuthentication,
    }),
  });
  if (!sso.response.ok) {
    throw new Error(`SSO prerequisite failed: HTTP ${sso.response.status} ${sso.text.slice(0, 500)}`);
  }
  await enableScimFixtureSso(den.database, organizationId);
  const enabledSso = await denFetch(den.ref, "/v1/sso", { headers: adminHeaders });
  const connection = isRecord(enabledSso.body) && isRecord(enabledSso.body.connection) ? enabledSso.body.connection : null;
  expect(connection?.domainVerified).toBe(true);
  expect(stringField(connection, "status")).toBe("enabled");
  return { organizationId, adminHeaders };
}

interface JourneyFacts {
  refusal: { claim: string; detail: string; passed: boolean };
  reprovision: { claim: string; detail: string; passed: boolean };
}

async function runDeprovisionedSsoJourney(org: JourneyOrg): Promise<JourneyFacts> {
  const { den, organizationId, adminHeaders, managedEmail, controlEmail, controlRole, mode } = org;
  if (!den.database) throw new Error("This journey reads Den's isolated local testkit database.");
  const databaseUrl = den.database.url;
  const orgHeaders = { ...adminHeaders };

  const tokenResult = await denFetch(den.ref, "/v1/scim/token", { method: "POST", headers: orgHeaders });
  const scimToken = stringField(tokenResult.body, "scimToken");
  if (tokenResult.response.status !== 201 || !scimToken) {
    throw new Error(`SCIM token creation failed: HTTP ${tokenResult.response.status} ${tokenResult.text.slice(0, 500)}`);
  }

  const idpUser = {
    schemas: [SCIM_USER_SCHEMA],
    userName: managedEmail,
    name: { givenName: "Avery", familyName: "Morgan" },
    emails: [{ primary: true, value: managedEmail, type: "work" }],
    externalId: `00u-${managedEmail.split("@")[0]}`,
    active: true,
    displayName: "Avery Morgan",
  };
  const created = await scimFetch(den.ref, "/Users", scimToken, { method: "POST", body: JSON.stringify(idpUser) });
  const scimUserId = stringField(created.body, "id");
  if (created.response.status !== 201 || !scimUserId) {
    throw new Error(`SCIM user creation failed: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
  }
  await eventually(
    () => denFetch(den.ref, "/v1/org", { headers: orgHeaders }),
    { within: 90_000, label: "SCIM-created member to appear in organization context", until: ({ response, body }) => response.ok && orgHasJoinedMember(body, managedEmail) },
  );

  // The IdP deactivates the assignment. Den removes the member and tombstones
  // the identity; the global user goes with its last active membership.
  const deactivated = await scimFetch(den.ref, `/Users/${encodeURIComponent(scimUserId)}`, scimToken, {
    method: "PATCH",
    body: JSON.stringify({ schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: "replace", value: { active: false } }] }),
  });
  expect(deactivated.response.status, `deactivate: HTTP ${deactivated.response.status} ${deactivated.text.slice(0, 300)}`).toBe(204);
  await eventually(
    () => denFetch(den.ref, "/v1/org", { headers: orgHeaders }),
    { within: 90_000, label: "SCIM-deprovisioned member to leave organization context", until: ({ response, body }) => response.ok && !orgHasJoinedMember(body, managedEmail) },
  );
  const userRowsAfterDeprovision = await queryDenDatabase(databaseUrl, "SELECT id FROM `user` WHERE email = ?", [managedEmail]);
  expect(userRowsAfterDeprovision, "deprovisioned user row").toHaveLength(0);

  // ── The deactivated person still tries the SSO link ──────────────────────
  const ssoAttempt = await attemptSsoSignIn(den, managedEmail);
  const userRowsAfterSso = await queryDenDatabase(databaseUrl, "SELECT id FROM `user` WHERE email = ?", [managedEmail]);
  const sessionRowsAfterSso = await queryDenDatabase(
    databaseUrl,
    "SELECT s.id FROM `session` s INNER JOIN `user` u ON u.id = s.user_id WHERE u.email = ?",
    [managedEmail],
  );
  const orgAfterSso = await denFetch(den.ref, "/v1/org", { headers: orgHeaders });
  expect(ssoAttempt.response.status, `SSO callback: HTTP ${ssoAttempt.response.status} ${ssoAttempt.text.slice(0, 300)}`).toBe(403);
  expect(stringField(ssoAttempt.body, "message")).toBe(DEPROVISIONED_MESSAGE);
  expect(ssoAttempt.sessionCookieIssued).toBe(false);
  expect(userRowsAfterSso, `ghost user rows after refused SSO (${mode})`).toHaveLength(0);
  expect(sessionRowsAfterSso, `ghost session rows after refused SSO (${mode})`).toHaveLength(0);
  expect(orgAfterSso.response.ok).toBe(true);
  expect(orgHasJoinedMember(orgAfterSso.body, managedEmail), `ghost membership after refused SSO (${mode})`).toBe(false);
  expect(orgHasJoinedMember(orgAfterSso.body, controlEmail)).toBe(true);
  expect(orgMemberRole(orgAfterSso.body, controlEmail)).toBe(controlRole);
  const refusal = {
    claim: `A SCIM-deprovisioned person is refused at the SSO callback without leaving a ghost identity (${mode})`,
    detail: `The OIDC callback returned ${ssoAttempt.response.status} "${stringField(ssoAttempt.body, "message")}" with no session cookie; afterwards the database holds ${userRowsAfterSso.length} user row(s) and ${sessionRowsAfterSso.length} session row(s) for ${managedEmail}, /v1/org lists no joined member for that email, and ${controlEmail} remains ${orgMemberRole(orgAfterSso.body, controlEmail)}.`,
    passed: ssoAttempt.response.status === 403
      && stringField(ssoAttempt.body, "message") === DEPROVISIONED_MESSAGE
      && !ssoAttempt.sessionCookieIssued
      && userRowsAfterSso.length === 0
      && sessionRowsAfterSso.length === 0
      && !orgHasJoinedMember(orgAfterSso.body, managedEmail)
      && orgHasJoinedMember(orgAfterSso.body, controlEmail)
      && orgMemberRole(orgAfterSso.body, controlEmail) === controlRole,
  };

  // ── The IdP reactivates the assignment: the same POST /Users must win ────
  const reprovisioned = await scimFetch(den.ref, "/Users", scimToken, { method: "POST", body: JSON.stringify(idpUser) });
  const reprovisionedId = stringField(reprovisioned.body, "id");
  expect(reprovisioned.response.status, `re-provision after refused SSO: HTTP ${reprovisioned.response.status} ${reprovisioned.text.slice(0, 300)}`).toBe(201);
  if (!reprovisionedId) {
    throw new Error(`SCIM re-provisioning omitted id: HTTP ${reprovisioned.response.status} ${reprovisioned.text.slice(0, 500)}`);
  }
  const orgAfterReprovision = await eventually(
    () => denFetch(den.ref, "/v1/org", { headers: orgHeaders }),
    { within: 90_000, label: "re-provisioned SCIM member to join organization context", until: ({ response, body }) => response.ok && orgHasJoinedMember(body, managedEmail) },
  );
  const reprovisionedGet = await scimFetch(den.ref, `/Users/${encodeURIComponent(reprovisionedId)}`, scimToken);
  const userRowsAfterReprovision = await queryDenDatabase(databaseUrl, "SELECT id FROM `user` WHERE email = ?", [managedEmail]);
  const passwordAfterReprovision = await denFetch(den.ref, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: managedEmail, password: "PasswordMustNotWork123!" }),
  });
  expect(reprovisionedGet.response.status).toBe(200);
  expect(isRecord(reprovisionedGet.body) && reprovisionedGet.body.active).toBe(true);
  expect(orgHasJoinedMember(orgAfterReprovision.body, managedEmail)).toBe(true);
  expect(orgMemberRole(orgAfterReprovision.body, managedEmail)).toBe("member");
  expect(userRowsAfterReprovision, "exactly one user row after re-provision").toHaveLength(1);
  expect(passwordAfterReprovision.response.ok).toBe(false);
  expect(orgMemberRole(orgAfterReprovision.body, controlEmail)).toBe(controlRole);
  const reprovision = {
    claim: `The IdP's re-provision restores access after the refused SSO attempt (${mode})`,
    detail: `POST /Users for ${managedEmail} returned ${reprovisioned.response.status} with id ${reprovisionedId}; GET reports active=${isRecord(reprovisionedGet.body) ? String(reprovisionedGet.body.active) : "?"}, /v1/org lists the member as ${orgMemberRole(orgAfterReprovision.body, managedEmail)}, exactly ${userRowsAfterReprovision.length} user row exists, password sign-in returned ${passwordAfterReprovision.response.status}, and ${controlEmail} is still ${orgMemberRole(orgAfterReprovision.body, controlEmail)}.`,
    passed: reprovisioned.response.status === 201
      && reprovisionedGet.response.status === 200
      && isRecord(reprovisionedGet.body)
      && reprovisionedGet.body.active === true
      && orgHasJoinedMember(orgAfterReprovision.body, managedEmail)
      && orgMemberRole(orgAfterReprovision.body, managedEmail) === "member"
      && userRowsAfterReprovision.length === 1
      && !passwordAfterReprovision.response.ok
      && orgMemberRole(orgAfterReprovision.body, controlEmail) === controlRole,
  };
  return { refusal, reprovision };
}

test("a SCIM-deactivated member who tries SSO is refused without a ghost identity, so the IdP can re-provision them (multi-org Den)", { timeout: 600_000 }, async ({ evidence, place }) => {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const managedDomain = `okta-scim-${runId}.test`;
  const managedEmail = `avery.${runId}@${managedDomain}`;
  await using idp = await startMockIdpLab({ domain: managedDomain, defaultSubject: { email: managedEmail, name: "Avery Morgan" } });
  await using den = await server({
    place,
    web: false,
    trustedOrigins: [new URL(idp.issuer).origin],
    org: { name: `SCIM SSO Ghost ${runId}`, admin: { name: "SCIM Admin" } },
  });
  const control = await inviteMember(den, "control", { email: `control.${runId}@openwork.test`, name: "Control Member" });
  const { organizationId, adminHeaders } = await registerEnabledOidcSso(den, idp);
  const facts = await runDeprovisionedSsoJourney({
    den,
    organizationId,
    adminHeaders,
    managedEmail,
    controlEmail: control.email,
    controlRole: "member",
    mode: "multi_org",
  });
  evidence.recordAssertionEvidence(facts.refusal.claim, facts.refusal.detail, facts.refusal.passed);
  evidence.recordAssertionEvidence(facts.reprovision.claim, facts.reprovision.detail, facts.reprovision.passed);
});

test("a SCIM-deactivated member who tries SSO is refused without a ghost identity, so the IdP can re-provision them (single-org Den)", { timeout: 600_000 }, async ({ evidence, place }) => {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const managedDomain = `okta-scim-${runId}.test`;
  const managedEmail = `avery.${runId}@${managedDomain}`;
  const adminEmail = `admin.${runId}@openwork.test`;
  await using idp = await startMockIdpLab({ domain: managedDomain, defaultSubject: { email: managedEmail, name: "Avery Morgan" } });
  await using den = await server({
    place,
    web: false,
    provision: false,
    trustedOrigins: [new URL(idp.issuer).origin],
    env: {
      DEN_ORG_MODE: "single_org",
      DEN_SINGLE_ORG_NAME: `SCIM SSO Ghost ${runId}`,
      DEN_SINGLE_ORG_SLUG: `scim-sso-ghost-${runId}`,
      DEN_SINGLE_ORG_OWNER_EMAILS: adminEmail,
      DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "true",
    },
  });
  // The first owner-listed sign-in materialises the singleton organization.
  const admin = await createAdmin(den, { email: adminEmail, name: "SCIM Admin" });
  const { organizationId, adminHeaders } = await registerEnabledOidcSso(den, idp);
  const facts = await runDeprovisionedSsoJourney({
    den,
    organizationId,
    adminHeaders,
    managedEmail,
    controlEmail: admin.email,
    controlRole: "owner",
    mode: "single_org",
  });
  evidence.recordAssertionEvidence(facts.refusal.claim, facts.refusal.detail, facts.refusal.passed);
  evidence.recordAssertionEvidence(facts.reprovision.claim, facts.reprovision.detail, facts.reprovision.passed);
});
