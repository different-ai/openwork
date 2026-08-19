import { expect } from "vitest";
import { denFetch, evalIn, provisionOrg, waitFor } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import { startMockIdpLab } from "@openwork/labs";
import { localMysqlIsRunning, server, test } from "@openwork/testkit";

const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !localPlacement
  ? "SSO domain verification skipped — needs local placement without OPENWORK_EVAL_DEN_API_URL"
  : !mysqlOpen
    ? "SSO domain verification skipped — needs MySQL on 127.0.0.1:3306"
    : "an unverified SSO connection stays pending and gives the owner complete DNS instructions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string): string {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

test.skipIf(!localPlacement || !mysqlOpen)(title, async ({ evidence, place }) => {
  const ssoDomain = `pending-sso-${Date.now()}.test`;
  await using idp = await startMockIdpLab({
    issuer: "http://0.0.0.0:19191",
    domain: ssoDomain,
  });
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
  const organizationSlug = readString(organization, "slug");
  expect(organizationSlug).toBeTruthy();

  const registration = idp.registration();
  const registered = await denFetch(den.ref, "/v1/sso/oidc", {
    method: "POST",
    headers: {
      authorization: `Bearer ${org.admin.token}`,
      cookie: sessionCookie,
      "x-openwork-org-id": org.orgId,
    },
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
  expect(registered.response.ok, registered.text).toBe(true);
  const registeredConnection = isRecord(registered.body) && isRecord(registered.body.connection)
    ? registered.body.connection
    : null;
  const providerId = readString(registeredConnection, "providerId");
  const domainVerificationToken = readString(registered.body, "domainVerificationToken");
  const expectedHost = `_better-auth-token-${providerId}`;
  const expectedDnsName = `${expectedHost}.${ssoDomain}`;
  expect(domainVerificationToken).toBeTruthy();
  expect(registeredConnection?.domainVerified).toBe(false);
  expect(readString(registeredConnection, "status")).toBe("pending_verification");
  expect(readString(registeredConnection, "domainVerificationHost")).toBe(expectedHost);
  expect(readString(registeredConnection, "domainVerificationDnsName")).toBe(expectedDnsName);

  const loginOptions = await denFetch(
    den.ref,
    `/v1/auth/login-options?email=${encodeURIComponent(`new-user@${ssoDomain}`)}`,
  );
  expect(loginOptions.response.ok, loginOptions.text).toBe(true);
  expect(readString(loginOptions.body, "nextStep")).not.toBe("sso");

  const directSso = await denFetch(den.ref, "/api/auth/sign-in/sso", {
    method: "POST",
    body: JSON.stringify({
      organizationSlug,
      callbackURL: `${den.ref.webUrl}/dashboard`,
    }),
  });
  expect(directSso.response.ok).toBe(false);
  expect(directSso.text).toMatch(/has not been verified/i);
  evidence.recordAssertionEvidence(
    "Unverified SSO is configured but inactive",
    `status=${readString(registeredConnection, "status")}; login next step=${readString(loginOptions.body, "nextStep")}; direct SSO HTTP ${directSso.response.status}`,
    readString(registeredConnection, "status") === "pending_verification"
      && readString(loginOptions.body, "nextStep") !== "sso"
      && !directSso.response.ok,
  );

  await using browser = await chrome({
    name: "sso-domain-verification",
    startUrl: den.ref.webUrl,
    headless: true,
    host: place.host(),
  });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web before owner auth handoff",
  });
  const cookieSeparator = sessionCookie.indexOf("=");
  const browserSessionCookie = await browser.client.send("Network.setCookie", {
    name: sessionCookie.slice(0, cookieSeparator),
    value: sessionCookie.slice(cookieSeparator + 1),
    url: den.ref.webUrl,
    httpOnly: true,
  });
  expect(browserSessionCookie.success).toBe(true);
  const tokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(org.admin.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(org.admin.token)};
  })()`);
  expect(tokenStored).toBe(true);
  await navigate(browser.client, `${den.ref.webUrl}/dashboard/sso`);
  await waitFor(browser, `Boolean(document.querySelector('[data-testid="sso-domain-verification"]'))`, {
    timeoutMs: 60_000,
    label: "pending SSO verification card",
  });

  const requested = await evalIn(browser, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => /request token/i.test(candidate.textContent ?? ""));
    button?.click();
    return Boolean(button);
  })()`);
  expect(requested).toBe(true);
  await waitFor(browser, `document.body.innerText.includes(${JSON.stringify(expectedDnsName)}) && document.body.innerText.includes(${JSON.stringify(domainVerificationToken)})`, {
    timeoutMs: 30_000,
    label: "complete DNS verification record with token value",
  });

  const ui: unknown = JSON.parse(String(await evalIn(browser, `(() => {
    const verification = document.querySelector('[data-testid="sso-domain-verification"]');
    const setup = document.querySelector('[data-testid="sso-provider-setup"]');
    const text = verification?.textContent?.replace(/\\s+/g, " ").trim() ?? "";
    return JSON.stringify({
      appearsBeforeProviderSetup: Boolean(verification && setup && (verification.compareDocumentPosition(setup) & Node.DOCUMENT_POSITION_FOLLOWING)),
      hasTxtType: /TXT/.test(text),
      hasHost: text.includes(${JSON.stringify(expectedHost)}),
      hasFullName: text.includes(${JSON.stringify(expectedDnsName)}),
      hasToken: text.includes(${JSON.stringify(domainVerificationToken)}),
      saysPending: /pending verification/i.test(text),
      saysRemovable: /remove.*TXT record/i.test(text),
      hasSkip: /skip verification/i.test(text),
      text,
    });
  })()`)));
  expect(ui).toMatchObject({
    appearsBeforeProviderSetup: true,
    hasTxtType: true,
    hasHost: true,
    hasFullName: true,
    hasToken: true,
    saysPending: true,
    saysRemovable: true,
    hasSkip: false,
  });
  evidence.recordAssertionEvidence(
    "The owner sees domain verification first with complete, one-time DNS instructions",
    readString(ui, "text"),
    isRecord(ui)
      && ui.appearsBeforeProviderSetup === true
      && ui.hasTxtType === true
      && ui.hasHost === true
      && ui.hasFullName === true
      && ui.hasToken === true
      && ui.saysPending === true
      && ui.saysRemovable === true
      && ui.hasSkip === false,
  );
});
