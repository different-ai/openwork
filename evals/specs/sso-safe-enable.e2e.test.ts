import { expect } from "vitest";
import { denFetch, provisionOrg } from "@openwork/behaviors";
import { startMockIdpLab } from "@openwork/labs";
import { localMysqlIsRunning, server, test } from "@openwork/testkit";

const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const unavailable = localPlacement && !mysqlOpen;
const title = unavailable
    ? "safe SSO enablement skipped — needs MySQL on 127.0.0.1:3306"
    : "an owner tests the saved SSO configuration before explicitly enabling enforcement";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string) {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

function connectionFrom(value: unknown) {
  return isRecord(value) && isRecord(value.connection) ? value.connection : null;
}

function cookieHeader(...responses: Response[]) {
  return responses
    .flatMap((response) => response.headers.getSetCookie())
    .map((cookie) => cookie.split(";", 1)[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ");
}

async function completeSsoTest(input: {
  denRef: Parameters<typeof denFetch>[0];
  intentId: string;
  headers: Record<string, string>;
}) {
  const started = await denFetch(input.denRef, `/v1/sso/test/${encodeURIComponent(input.intentId)}/start`, {
    method: "POST",
    headers: input.headers,
    body: JSON.stringify({}),
  });
  const authorizationUrl = stringField(started.body, "url");
  expect(authorizationUrl, started.text).toBeTruthy();
  const authorized = await fetch(authorizationUrl, { redirect: "manual" });
  const callbackUrl = authorized.headers.get("location") ?? "";
  expect(callbackUrl).toBeTruthy();
  const callback = await fetch(callbackUrl, {
    headers: { cookie: [input.headers.cookie, cookieHeader(started.response)].filter(Boolean).join("; ") },
    redirect: "manual",
  });
  expect(callback.status).toBeGreaterThanOrEqual(300);
  expect(callback.status).toBeLessThan(500);
}

test.skipIf(unavailable)(title, async ({ evidence, place }) => {
  await using idp = await startMockIdpLab({ domain: "example.test" });
  await using den = await server({ place, trustedOrigins: [new URL(idp.issuer).origin] });
  const org = await provisionOrg(den.ref, { members: [] });
  const signedIn = await denFetch(den.ref, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: org.admin.email, password: org.admin.password }),
  });
  const sessionCookie = signedIn.response.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "";
  expect(sessionCookie).toBeTruthy();

  const organizations = await denFetch(den.ref, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${org.admin.token}` },
  });
  const organization = isRecord(organizations.body)
    && Array.isArray(organizations.body.orgs)
    && isRecord(organizations.body.orgs[0])
    ? organizations.body.orgs[0]
    : null;
  const organizationSlug = stringField(organization, "slug");
  expect(organizationSlug).toBeTruthy();

  const registration = idp.registration();
  const registrationBody = {
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
  };
  const orgHeaders = {
    authorization: `Bearer ${org.admin.token}`,
    cookie: sessionCookie,
    "x-openwork-org-id": org.orgId,
  };
  const registered = await denFetch(den.ref, "/v1/sso/oidc", {
    method: "POST",
    headers: orgHeaders,
    body: JSON.stringify(registrationBody),
  });
  expect(registered.response.ok, registered.text).toBe(true);
  const savedConnection = connectionFrom(registered.body);
  expect(stringField(savedConnection, "status")).toBe("disabled");
  expect(stringField(savedConnection, "testStatus")).toBe("untested");
  expect(savedConnection?.domainVerified).toBe(true);

  const beforeEnable = await denFetch(den.ref, `/v1/auth/login-options?email=${encodeURIComponent(`member-${Date.now()}@example.test`)}`);
  expect(stringField(beforeEnable.body, "nextStep")).not.toBe("sso");
  const ordinaryDirectSignIn = await denFetch(den.ref, "/api/auth/sign-in/sso", {
    method: "POST",
    body: JSON.stringify({ organizationSlug, callbackURL: `${den.ref.webUrl}/dashboard` }),
  });
  expect(ordinaryDirectSignIn.response.status).toBe(403);

  const createdTest = await denFetch(den.ref, "/v1/sso/test", {
    method: "POST",
    headers: orgHeaders,
    body: JSON.stringify({}),
  });
  expect(createdTest.response.ok, createdTest.text).toBe(true);
  const testUrl = stringField(createdTest.body, "testUrl");
  expect(testUrl).toBeTruthy();

  await completeSsoTest({
    denRef: den.ref,
    intentId: stringField(createdTest.body, "intentId"),
    headers: orgHeaders,
  });

  let testedConnection: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await denFetch(den.ref, "/v1/sso", { headers: orgHeaders });
    testedConnection = connectionFrom(current.body);
    if (stringField(testedConnection, "testStatus") === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(stringField(testedConnection, "status")).toBe("disabled");
  expect(stringField(testedConnection, "testStatus")).toBe("succeeded");

  const enabled = await denFetch(den.ref, "/v1/sso/enable", {
    method: "POST",
    headers: orgHeaders,
    body: JSON.stringify({}),
  });
  expect(enabled.response.status, enabled.text).toBe(204);
  const afterEnable = await denFetch(den.ref, `/v1/auth/login-options?email=${encodeURIComponent(`member-${Date.now()}@example.test`)}`);
  expect(stringField(afterEnable.body, "nextStep")).toBe("sso");

  const savedAgain = await denFetch(den.ref, "/v1/sso/oidc", {
    method: "POST",
    headers: orgHeaders,
    body: JSON.stringify(registrationBody),
  });
  const editedConnection = connectionFrom(savedAgain.body);
  expect(stringField(editedConnection, "status")).toBe("disabled");
  expect(stringField(editedConnection, "testStatus")).toBe("untested");
  const staleEnable = await denFetch(den.ref, "/v1/sso/enable", {
    method: "POST",
    headers: orgHeaders,
    body: JSON.stringify({}),
  });
  expect(staleEnable.response.status).toBe(409);

  const brokenSave = await denFetch(den.ref, "/v1/sso/oidc", {
    method: "POST",
    headers: orgHeaders,
    body: JSON.stringify({ ...registrationBody, clientSecret: "incorrect-test-client-secret" }),
  });
  expect(brokenSave.response.ok, brokenSave.text).toBe(true);
  const createdFailedTest = await denFetch(den.ref, "/v1/sso/test", {
    method: "POST",
    headers: orgHeaders,
    body: JSON.stringify({}),
  });
  const failedTestUrl = stringField(createdFailedTest.body, "testUrl");
  expect(failedTestUrl).toBeTruthy();
  await completeSsoTest({
    denRef: den.ref,
    intentId: stringField(createdFailedTest.body, "intentId"),
    headers: orgHeaders,
  });
  let failedConnection: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await denFetch(den.ref, "/v1/sso", { headers: orgHeaders });
    failedConnection = connectionFrom(current.body);
    if (stringField(failedConnection, "testStatus") === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(stringField(failedConnection, "status")).toBe("disabled");
  expect(stringField(failedConnection, "testStatus")).toBe("failed");
  expect(stringField(failedConnection, "lastError")).toMatch(/did not complete successfully/i);
  expect(stringField(failedConnection, "lastError")).not.toContain("incorrect-test-client-secret");

  evidence.recordAssertionEvidence(
    "SSO remains disabled until the current saved configuration authenticates successfully and the owner explicitly enables it",
    `saved=${stringField(savedConnection, "status")}/${stringField(savedConnection, "testStatus")}; tested=${stringField(testedConnection, "status")}/${stringField(testedConnection, "testStatus")}; enabled login=${stringField(afterEnable.body, "nextStep")}; edited=${stringField(editedConnection, "status")}/${stringField(editedConnection, "testStatus")}; failed=${stringField(failedConnection, "status")}/${stringField(failedConnection, "testStatus")}`,
    stringField(savedConnection, "status") === "disabled"
      && stringField(testedConnection, "status") === "disabled"
      && stringField(testedConnection, "testStatus") === "succeeded"
      && stringField(afterEnable.body, "nextStep") === "sso"
      && stringField(editedConnection, "status") === "disabled"
      && staleEnable.response.status === 409
      && stringField(failedConnection, "status") === "disabled"
      && stringField(failedConnection, "testStatus") === "failed",
  );
});
