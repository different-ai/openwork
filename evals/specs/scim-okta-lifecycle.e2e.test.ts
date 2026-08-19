import { expect } from "vitest";
import { denFetch, signIn } from "@openwork/behaviors";
import { eventually, inviteMember, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Okta-shaped SCIM lifecycle skipped — needs: ${missingRequirements.join(", ")}`
  : "an Okta-shaped SCIM client provisions, renames, deprovisions, and reactivates a member without ever granting password access";

const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function numberField(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "number" ? field : null;
}

function recordsField(value: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return [];
  return value[key].filter(isRecord);
}

async function scimFetch(
  apiUrl: string,
  path: string,
  bearer: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: unknown; text: string }> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bearer}`);
  headers.set("accept", "application/scim+json, application/json");
  headers.set("content-type", "application/scim+json");
  const response = await fetch(`${apiUrl.replace(/\/+$/, "")}${path}`, {
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

function orgHasJoinedMember(body: unknown, email: string): boolean {
  return recordsField(body, "members").some((member) => {
    const user = member.user;
    return typeof member.userId === "string" && isRecord(user) && user.email === email;
  });
}

function formattedName(body: unknown): string | null {
  if (!isRecord(body)) return null;
  return stringField(body.name, "formatted");
}

test(title, { timeout: 1_800_000 }, async ({ evidence, place }) => {
  needs(requirements);

  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const orgName = `Okta SCIM Lifecycle ${runId}`;
  const managedDomain = "okta-scim.test";
  const managedEmail = `avery.${runId}@${managedDomain}`;
  const controlPassword = "OpenWorkEval123!";

  await using den = await server({
    place,
    org: {
      name: orgName,
      admin: { name: "SCIM Admin" },
    },
  });
  const control = await inviteMember(den, "control", {
    email: `control.${runId}@openwork.test`,
    name: "Control Member",
    password: controlPassword,
  });
  const controlSession = await signIn(den.ref, { email: control.email, password: controlPassword });

  const organizations = await denFetch(den.ref, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  });
  const organization = recordsField(organizations.body, "orgs").find((entry) => entry.name === orgName);
  const organizationId = stringField(organization, "id");
  if (!organizations.response.ok || !organizationId) {
    throw new Error(`Organization lookup failed: HTTP ${organizations.response.status} ${organizations.text.slice(0, 500)}`);
  }

  // The org-scoped token route requires a verified, enabled SSO connection.
  // Den's dev-loopback issuer path makes domain verification deterministic in
  // the eval while the Okta-shaped entry point, certificate, and ACS contract
  // remain real.
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
  const sso = await denFetch(den.ref, "/v1/sso/saml", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      issuer: `http://127.0.0.1/okta/exk-${runId}`,
      domain: managedDomain,
      entryPoint: `https://okta.example.test/app/openwork/exk-${runId}/sso/saml`,
      cert: "okta-test-signing-certificate",
      audience: den.ref.apiUrl,
    }),
  });
  if (!sso.response.ok) {
    throw new Error(`SSO prerequisite failed: HTTP ${sso.response.status} ${sso.text.slice(0, 500)}`);
  }

  const ssoConnection = isRecord(sso.body) && isRecord(sso.body.connection) ? sso.body.connection : null;
  expect(ssoConnection?.domainVerified).toBe(true);
  expect(stringField(ssoConnection, "status")).toBe("enabled");
  const acsUrl = stringField(ssoConnection, "acsUrl");
  if (!acsUrl) {
    throw new Error(`SAML registration did not advertise an ACS URL: ${sso.text.slice(0, 500)}`);
  }
  const malformedSaml = await fetch(acsUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ SAMLResponse: "not-base64-xml" }),
    signal: AbortSignal.timeout(30_000),
  });
  const malformedSamlBody: unknown = await malformedSaml.json();
  expect(stringField(malformedSamlBody, "error")).toBe("invalid_encoding");
  expect(stringField(malformedSamlBody, "error")).not.toBe("invalid_saml_configuration");
  evidence.recordAssertionEvidence(
    "Okta SAML registration persists a usable ACS callback configuration",
    `POSTing a deliberately malformed assertion to the advertised ACS URL reached response-policy validation and returned invalid_encoding, not invalid_saml_configuration.`,
    malformedSaml.status === 400
      && stringField(malformedSamlBody, "error") === "invalid_encoding",
  );

  // ── Frame 1: Den issues the org's Okta bearer, never a raw BA token ──────
  const scimBasePath = "/api/auth/scim/v2";
  const garbage = await scimFetch(den.ref.apiUrl, `${scimBasePath}/Users`, "nonsense");
  expect(garbage.response.status).toBe(401);

  const tokenResult = await denFetch(den.ref, "/v1/scim/token", {
    method: "POST",
    headers: adminHeaders,
  });
  const scimToken = stringField(tokenResult.body, "scimToken");
  const advertisedBaseUrl = stringField(tokenResult.body, "baseUrl");
  if (tokenResult.response.status !== 201 || !scimToken || !advertisedBaseUrl) {
    throw new Error(`SCIM token creation failed: HTTP ${tokenResult.response.status} ${tokenResult.text.slice(0, 500)}`);
  }
  expect(new URL(advertisedBaseUrl).pathname).toBe(scimBasePath);
  const emptyAfterGarbage = await scimFetch(den.ref.apiUrl, `${scimBasePath}/Users`, scimToken);
  expect(emptyAfterGarbage.response.status).toBe(200);
  expect(
    numberField(emptyAfterGarbage.body, "totalResults"),
    `list after garbage bearer: HTTP ${emptyAfterGarbage.response.status} ${emptyAfterGarbage.text.slice(0, 300)}`,
  ).toBe(0);
  evidence.recordAssertionEvidence(
    "Den issues an org-scoped SCIM bearer and rejects the garbage bearer without mutation",
    `POST /v1/scim/token advertised ${advertisedBaseUrl}; Bearer nonsense returned ${garbage.response.status}, and the new real bearer then listed totalResults=0.`,
    tokenResult.response.status === 201
      && new URL(advertisedBaseUrl).pathname === scimBasePath
      && garbage.response.status === 401
      && emptyAfterGarbage.response.status === 200
      && numberField(emptyAfterGarbage.body, "totalResults") === 0,
  );

  // ── Frame 2: Okta checks for an existing assignment before creating it ───
  const lookup = await scimFetch(
    den.ref.apiUrl,
    `${scimBasePath}/Users?filter=${encodeURIComponent(`userName eq "${managedEmail}"`)}`,
    scimToken,
  );
  expect(lookup.response.status).toBe(200);
  expect(
    numberField(lookup.body, "totalResults"),
    `pre-create lookup totalResults: HTTP ${lookup.response.status} ${lookup.text.slice(0, 300)}`,
  ).toBe(0);
  expect(
    recordsField(lookup.body, "Resources"),
    `pre-create lookup Resources: HTTP ${lookup.response.status} ${lookup.text.slice(0, 300)}`,
  ).toHaveLength(0);
  evidence.recordAssertionEvidence(
    "Okta's pre-create lookup finds no existing assignment",
    `GET Users?filter=userName eq ${managedEmail} returned 200 with totalResults=0 and no Resources, so the later create cannot be mistaken for an update.`,
    lookup.response.status === 200
      && numberField(lookup.body, "totalResults") === 0
      && recordsField(lookup.body, "Resources").length === 0,
  );

  const oktaUser = {
    schemas: [SCIM_USER_SCHEMA],
    userName: managedEmail,
    name: { givenName: "Avery", familyName: "Morgan" },
    emails: [{ primary: true, value: managedEmail, type: "work" }],
    externalId: `00u-${runId}`,
    active: true,
    displayName: "Avery Morgan",
  };

  // ── Frame 3: Okta provisions membership, not a password credential ───────
  const created = await scimFetch(den.ref.apiUrl, `${scimBasePath}/Users`, scimToken, {
    method: "POST",
    body: JSON.stringify(oktaUser),
  });
  const scimUserId = stringField(created.body, "id");
  if (created.response.status !== 201 || !scimUserId) {
    throw new Error(`SCIM user creation failed: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
  }
  // SCIM writes bypass the 60s organizationContext cache TTL.
  const orgAfterCreate = await eventually(
    () => denFetch(den.ref, "/v1/org", { headers: adminHeaders }),
    {
      within: 90_000,
      label: "SCIM-created member to appear in organization context",
      until: ({ response, body }) => response.ok && orgHasJoinedMember(body, managedEmail),
    },
  );
  const passwordAfterCreate = await denFetch(den.ref, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: managedEmail, password: "not-a-scim-password" }),
  });
  const allAfterCreate = await scimFetch(den.ref.apiUrl, `${scimBasePath}/Users`, scimToken);
  expect(orgAfterCreate.response.ok).toBe(true);
  expect(orgHasJoinedMember(orgAfterCreate.body, managedEmail)).toBe(true);
  expect(passwordAfterCreate.response.ok).toBe(false);
  expect(
    numberField(allAfterCreate.body, "totalResults"),
    `list after create: HTTP ${allAfterCreate.response.status} ${allAfterCreate.text.slice(0, 300)}`,
  ).toBe(1);
  evidence.recordAssertionEvidence(
    "Okta creates only federated access",
    `After the zero-user baseline, the real token lists exactly one SCIM resource (${managedEmail}), /v1/org includes that member within the 60s org-context cache window, and password sign-in returned ${passwordAfterCreate.response.status}; the rejected garbage call therefore added no extra resource.`,
    numberField(allAfterCreate.body, "totalResults") === 1
      && orgHasJoinedMember(orgAfterCreate.body, managedEmail)
      && !passwordAfterCreate.response.ok,
  );

  // ── Frame 4: Okta's full profile replacement changes only that profile ───
  const renamedUser = {
    ...oktaUser,
    name: { givenName: "Avery", familyName: "Nguyen" },
    displayName: "Avery Nguyen",
  };
  const renamed = await scimFetch(den.ref.apiUrl, `${scimBasePath}/Users/${encodeURIComponent(scimUserId)}`, scimToken, {
    method: "PUT",
    body: JSON.stringify(renamedUser),
  });
  const renamedGet = await scimFetch(den.ref.apiUrl, `${scimBasePath}/Users/${encodeURIComponent(scimUserId)}`, scimToken);
  expect(renamed.response.status).toBe(200);
  expect(renamedGet.response.status).toBe(200);
  expect(
    formattedName(renamedGet.body),
    `renamed user formatted name: HTTP ${renamedGet.response.status} ${renamedGet.text.slice(0, 300)}`,
  ).toBe("Avery Nguyen");
  expect(
    formattedName(renamedGet.body),
    `renamed user old formatted name: HTTP ${renamedGet.response.status} ${renamedGet.text.slice(0, 300)}`,
  ).not.toBe("Avery Morgan");
  evidence.recordAssertionEvidence(
    "Okta's full replace updates the family name without retaining the old profile",
    `PUT and GET returned ${renamed.response.status}/${renamedGet.response.status}; GET formatted the name as ${formattedName(renamedGet.body)}, not Avery Morgan.`,
    renamed.response.status === 200
      && renamedGet.response.status === 200
      && formattedName(renamedGet.body) === "Avery Nguyen",
  );

  // ── Frame 5: deprovisioning blocks resurrection and leaves others alone ──
  const deactivated = await scimFetch(den.ref.apiUrl, `${scimBasePath}/Users/${encodeURIComponent(scimUserId)}`, scimToken, {
    method: "PATCH",
    body: JSON.stringify({
      schemas: [SCIM_PATCH_SCHEMA],
      Operations: [{ op: "replace", value: { active: false } }],
    }),
  });
  expect(
    deactivated.response.status,
    `deactivate user: HTTP ${deactivated.response.status} ${deactivated.text.slice(0, 300)}`,
  ).toBe(204);

  // SCIM writes bypass the 60s organizationContext cache TTL.
  const orgAfterDeprovision = await eventually(
    () => denFetch(den.ref, "/v1/org", { headers: adminHeaders }),
    {
      within: 90_000,
      label: "SCIM-deprovisioned member to leave organization context",
      until: ({ response, body }) => response.ok && !orgHasJoinedMember(body, managedEmail),
    },
  );
  const passwordAfterDeprovision = await denFetch(den.ref, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: managedEmail, password: "still-not-a-scim-password" }),
  });
  const resurrectionInvite = await denFetch(den.ref, "/v1/invitations", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email: managedEmail, role: "member" }),
  });
  const resurrectionToken = stringField(resurrectionInvite.body, "inviteToken");
  if (!resurrectionInvite.response.ok || !resurrectionToken) {
    throw new Error(`Resurrection invitation failed to mint: HTTP ${resurrectionInvite.response.status} ${resurrectionInvite.text.slice(0, 500)}`);
  }
  const resurrectionSignUp = await denFetch(
    den.ref,
    `/api/auth/sign-up/email?invite=${encodeURIComponent(resurrectionToken)}`,
    {
      method: "POST",
      body: JSON.stringify({ email: managedEmail, name: "Avery Nguyen", password: "PasswordMustNotWork123!" }),
    },
  );
  const resurrectionSessionToken = stringField(resurrectionSignUp.body, "token");
  const explicitResurrection = resurrectionSessionToken
    ? await denFetch(den.ref, "/v1/orgs/invitations/accept", {
        method: "POST",
        headers: { authorization: `Bearer ${resurrectionSessionToken}` },
        body: JSON.stringify({ id: resurrectionToken }),
      })
    : null;
  const orgAfterInvite = await denFetch(den.ref, "/v1/org", { headers: adminHeaders });
  const pendingInvitation = recordsField(orgAfterInvite.body, "invitations")
    .find((invitation) => invitation.email === managedEmail);
  const pendingInvitationMember = recordsField(orgAfterInvite.body, "members")
    .find((member) => isRecord(member.user) && member.user.email === managedEmail);
  const controlMe = await denFetch(den.ref, "/v1/me", {
    headers: { authorization: `Bearer ${controlSession.token}` },
  });
  const controlMeEmail = isRecord(controlMe.body) && isRecord(controlMe.body.user)
    ? stringField(controlMe.body.user, "email")
    : null;
  expect(passwordAfterDeprovision.response.ok).toBe(false);
  if (explicitResurrection) {
    expect(
      explicitResurrection.response.status,
      `explicit resurrection refusal: HTTP ${explicitResurrection.response.status} ${explicitResurrection.text.slice(0, 300)}`,
    ).toBe(409);
    expect(stringField(explicitResurrection.body, "error")).toBe("scim_deprovisioned");
  }
  expect(orgHasJoinedMember(orgAfterDeprovision.body, managedEmail)).toBe(false);
  expect(orgHasJoinedMember(orgAfterInvite.body, managedEmail)).toBe(false);
  expect(stringField(pendingInvitation, "status")).not.toBe("accepted");
  expect(pendingInvitationMember?.userId).toBe(null);
  expect(orgHasJoinedMember(orgAfterInvite.body, control.email)).toBe(true);
  expect(controlMe.response.status).toBe(200);
  expect(controlMeEmail).toBe(control.email);
  evidence.recordAssertionEvidence(
    "Okta deprovisioning cannot be bypassed and does not touch the control member",
    `PATCH active=false returned 204; ${managedEmail} has no joined membership after invite-backed sign-up returned ${resurrectionSignUp.response.status}${explicitResurrection ? ` and explicit acceptance was refused with ${stringField(explicitResurrection.body, "error")}` : ""}. Invitations cannot resurrect an IdP-deprovisioned member: the refusal is org-scoped, the invitation remains unaccepted with userId null, and ${control.email}'s existing session and membership remain intact.`,
    deactivated.response.status === 204
      && !passwordAfterDeprovision.response.ok
      && (!explicitResurrection
        || (explicitResurrection.response.status === 409
          && stringField(explicitResurrection.body, "error") === "scim_deprovisioned"))
      && !orgHasJoinedMember(orgAfterInvite.body, managedEmail)
      && stringField(pendingInvitation, "status") !== "accepted"
      && pendingInvitationMember?.userId === null
      && orgHasJoinedMember(orgAfterInvite.body, control.email)
      && controlMe.response.status === 200
      && controlMeEmail === control.email,
  );

  // ── Frame 6A: Okta cannot absorb an existing personal account ────────────
  const averyReprovision = await scimFetch(den.ref.apiUrl, `${scimBasePath}/Users`, scimToken, {
    method: "POST",
    body: JSON.stringify(oktaUser),
  });
  expect(
    averyReprovision.response.status,
    `re-provision existing personal account: HTTP ${averyReprovision.response.status} ${averyReprovision.text.slice(0, 300)}`,
  ).toBe(409);
  expect(
    stringField(averyReprovision.body, "scimType"),
    `re-provision existing personal account semantics: HTTP ${averyReprovision.response.status} ${averyReprovision.text.slice(0, 300)}`,
  ).toBe("uniqueness");
  evidence.recordAssertionEvidence(
    "The IdP cannot silently absorb a pre-existing personal account",
    `Re-provisioning ${managedEmail}, now owned by a self-created account, returned SCIM ${averyReprovision.response.status} with scimType=${stringField(averyReprovision.body, "scimType")}.`,
    averyReprovision.response.status === 409
      && stringField(averyReprovision.body, "scimType") === "uniqueness",
  );

  // ── Frame 6B: Okta re-provisioning is the only way back in ───────────────
  const blakeEmail = `blake.${runId}@${managedDomain}`;
  const blakeUser = {
    schemas: [SCIM_USER_SCHEMA],
    userName: blakeEmail,
    name: { givenName: "Blake", familyName: "Morgan" },
    emails: [{ primary: true, value: blakeEmail, type: "work" }],
    externalId: `00u-blake-${runId}`,
    active: true,
    displayName: "Blake Morgan",
  };
  const blakeCreated = await scimFetch(den.ref.apiUrl, `${scimBasePath}/Users`, scimToken, {
    method: "POST",
    body: JSON.stringify(blakeUser),
  });
  const blakeUserId = stringField(blakeCreated.body, "id");
  expect(
    blakeCreated.response.status,
    `create fresh SCIM user: HTTP ${blakeCreated.response.status} ${blakeCreated.text.slice(0, 300)}`,
  ).toBe(201);
  if (!blakeUserId) {
    throw new Error(`Fresh SCIM user creation omitted id: HTTP ${blakeCreated.response.status} ${blakeCreated.text.slice(0, 500)}`);
  }
  // SCIM writes bypass the 60s organizationContext cache TTL.
  await eventually(
    () => denFetch(den.ref, "/v1/org", { headers: adminHeaders }),
    {
      within: 90_000,
      label: "fresh SCIM member to join organization context",
      until: ({ response, body }) => response.ok && orgHasJoinedMember(body, blakeEmail),
    },
  );
  const blakeDeactivated = await scimFetch(
    den.ref.apiUrl,
    `${scimBasePath}/Users/${encodeURIComponent(blakeUserId)}`,
    scimToken,
    {
      method: "PATCH",
      body: JSON.stringify({
        schemas: [SCIM_PATCH_SCHEMA],
        Operations: [{ op: "replace", value: { active: false } }],
      }),
    },
  );
  expect(
    blakeDeactivated.response.status,
    `deactivate fresh SCIM user: HTTP ${blakeDeactivated.response.status} ${blakeDeactivated.text.slice(0, 300)}`,
  ).toBe(204);
  // SCIM writes bypass the 60s organizationContext cache TTL.
  await eventually(
    () => denFetch(den.ref, "/v1/org", { headers: adminHeaders }),
    {
      within: 90_000,
      label: "deactivated fresh SCIM member to leave organization context",
      until: ({ response, body }) => response.ok && !orgHasJoinedMember(body, blakeEmail),
    },
  );
  const oldBlakeGet = await scimFetch(
    den.ref.apiUrl,
    `${scimBasePath}/Users/${encodeURIComponent(blakeUserId)}`,
    scimToken,
  );
  expect(
    oldBlakeGet.response.status,
    `old fresh-user id after deprovision: HTTP ${oldBlakeGet.response.status} ${oldBlakeGet.text.slice(0, 300)}`,
  ).toBe(404);
  const blakeReprovisioned = await scimFetch(den.ref.apiUrl, `${scimBasePath}/Users`, scimToken, {
    method: "POST",
    body: JSON.stringify(blakeUser),
  });
  const blakeReprovisionedId = stringField(blakeReprovisioned.body, "id");
  expect(
    blakeReprovisioned.response.status,
    `re-provision fresh SCIM user: HTTP ${blakeReprovisioned.response.status} ${blakeReprovisioned.text.slice(0, 300)}`,
  ).toBe(201);
  expect(
    blakeReprovisionedId,
    `re-provisioned fresh-user id: HTTP ${blakeReprovisioned.response.status} ${blakeReprovisioned.text.slice(0, 300)}`,
  ).not.toBe(blakeUserId);
  if (!blakeReprovisionedId) {
    throw new Error(`SCIM re-provisioning omitted id: HTTP ${blakeReprovisioned.response.status} ${blakeReprovisioned.text.slice(0, 500)}`);
  }
  // Re-provisioning clears removal memory; the 60s organizationContext cache still applies.
  const orgAfterBlakeReprovision = await eventually(
    () => denFetch(den.ref, "/v1/org", { headers: adminHeaders }),
    {
      within: 90_000,
      label: "re-provisioned fresh SCIM member to join organization context",
      until: ({ response, body }) => response.ok && orgHasJoinedMember(body, blakeEmail),
    },
  );
  const blakeReprovisionedGet = await scimFetch(
    den.ref.apiUrl,
    `${scimBasePath}/Users/${encodeURIComponent(blakeReprovisionedId)}`,
    scimToken,
  );
  const blakePassword = await denFetch(den.ref, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: blakeEmail, password: "PasswordMustStillNotWork123!" }),
  });
  const allAfterBlakeReprovision = await scimFetch(den.ref.apiUrl, `${scimBasePath}/Users`, scimToken);
  expect(orgHasJoinedMember(orgAfterBlakeReprovision.body, blakeEmail)).toBe(true);
  expect(
    blakeReprovisionedGet.response.status,
    `get re-provisioned fresh user: HTTP ${blakeReprovisionedGet.response.status} ${blakeReprovisionedGet.text.slice(0, 300)}`,
  ).toBe(200);
  expect(
    isRecord(blakeReprovisionedGet.body) && blakeReprovisionedGet.body.active,
    `re-provisioned fresh user active shape: HTTP ${blakeReprovisionedGet.response.status} ${blakeReprovisionedGet.text.slice(0, 300)}`,
  ).toBe(true);
  expect(
    numberField(allAfterBlakeReprovision.body, "totalResults"),
    `list after fresh-user re-provisioning: HTTP ${allAfterBlakeReprovision.response.status} ${allAfterBlakeReprovision.text.slice(0, 300)}`,
  ).toBe(1);
  expect(blakePassword.response.ok).toBe(false);
  evidence.recordAssertionEvidence(
    "Okta re-provisioning is the only way back in and still grants no password access",
    `Okta deprovisioned ${blakeEmail}, leaving old id ${blakeUserId} at 404, then POSTed the same userName/externalId into new id ${blakeReprovisionedId}; the new identity joined active with totalResults=1, while password sign-in returned ${blakePassword.response.status}.`,
    oldBlakeGet.response.status === 404
      && blakeReprovisioned.response.status === 201
      && blakeReprovisionedId !== blakeUserId
      && orgHasJoinedMember(orgAfterBlakeReprovision.body, blakeEmail)
      && isRecord(blakeReprovisionedGet.body)
      && blakeReprovisionedGet.body.active === true
      && numberField(allAfterBlakeReprovision.body, "totalResults") === 1
      && !blakePassword.response.ok,
  );
});
