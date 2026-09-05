import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { localMysqlIsRunning, server, test } from "@openwork/testkit";

const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !localPlacement
  ? "SAML ACS delivery skipped — needs local placement without OPENWORK_EVAL_DEN_API_URL"
  : !mysqlOpen
    ? "SAML ACS delivery skipped — needs MySQL on 127.0.0.1:3306"
    : "a Google-style SAML response posted to the SP-advertised ACS URL is not rejected as invalid_destination";

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

// A minimal, unsigned Google Workspace-shaped SAML response. It only needs to
// carry the fields the delivery policy inspects (Destination, Recipient,
// Audience, assertion ID); Better Auth's own signature validation rejects it
// afterwards, which is expected and asserted as a non-policy failure.
function googleSamlResponse(input: { destination: string; recipient: string; audience: string }): string {
  const xml = `
    <samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="response-${Date.now()}" Version="2.0" IssueInstant="2026-08-28T00:00:00Z" Destination="${input.destination}">
      <saml:Issuer>https://accounts.google.com/o/saml2?idpid=mock</saml:Issuer>
      <samlp:Status>
        <samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success" />
      </samlp:Status>
      <saml:Assertion ID="assertion-${Date.now()}" Version="2.0" IssueInstant="2026-08-28T00:00:00Z">
        <saml:Issuer>https://accounts.google.com/o/saml2?idpid=mock</saml:Issuer>
        <saml:Subject>
          <saml:NameID>enterprise-user@customer.test</saml:NameID>
          <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
            <saml:SubjectConfirmationData Recipient="${input.recipient}" NotOnOrAfter="2027-01-01T00:00:00Z" />
          </saml:SubjectConfirmation>
        </saml:Subject>
        <saml:Conditions NotBefore="2026-01-01T00:00:00Z" NotOnOrAfter="2027-01-01T00:00:00Z">
          <saml:AudienceRestriction>
            <saml:Audience>${input.audience}</saml:Audience>
          </saml:AudienceRestriction>
        </saml:Conditions>
      </saml:Assertion>
    </samlp:Response>
  `;
  return Buffer.from(xml, "utf8").toString("base64");
}

async function postToAcs(den: DenSession, acsPath: string, samlResponse: string) {
  return denFetch(den, acsPath, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: "openwork-eval" }).toString(),
  });
}

test.skipIf(!localPlacement || !mysqlOpen)(title, { timeout: 300_000 }, async ({ evidence, place }) => {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const organizationName = `SAML ACS delivery ${runId}`;

  await using den = await server({ place, org: { name: organizationName, members: {} } });
  const owner = den.admin;
  const orgId = await organizationId(owner, organizationName);

  const ownerSignIn = await denFetch(den.ref, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: owner.email, password: owner.password }),
  });
  const ownerCookie = ownerSignIn.response.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "";
  expect(ownerCookie).toBeTruthy();

  const orgHeaders = { ...auth(owner), cookie: ownerCookie, "x-openwork-org-id": orgId };
  const audience = den.ref.apiUrl;
  const registration = await denFetch(den.ref, "/v1/sso/saml", {
    method: "POST",
    headers: orgHeaders,
    body: JSON.stringify({
      issuer: "http://127.0.0.1/google-saml",
      domain: `saml-acs-${runId}.test`,
      entryPoint: "https://accounts.google.com/o/saml2/idp?idpid=mock",
      cert: "mock-google-signing-certificate",
      audience,
    }),
  });
  expect(registration.response.status, registration.text).toBe(201);
  const connection = isRecord(registration.body) && isRecord(registration.body.connection)
    ? registration.body.connection
    : null;
  const settingsAcsUrl = connection && typeof connection.acsUrl === "string" ? connection.acsUrl : "";
  const providerId = connection && typeof connection.providerId === "string" ? connection.providerId : "";
  expect(settingsAcsUrl).toBeTruthy();
  expect(providerId).toBeTruthy();

  // The mock IdP's view: the real SP metadata Better Auth generates. Google
  // Workspace posts the SAML response to the ACS location advertised here.
  const metadata = await denFetch(den.ref, "/v1/sso/metadata", { headers: orgHeaders });
  expect(metadata.response.status, metadata.text).toBe(200);
  const advertisedAcsUrl = metadata.text.match(/AssertionConsumerService[^>]*Location="([^"]+)"/)?.[1]
    ?? metadata.text.match(/Location="([^"]+\/sp\/acs\/[^"]+)"/)?.[1]
    ?? "";
  expect(advertisedAcsUrl, `SP metadata did not advertise an ACS location: ${metadata.text.slice(0, 800)}`).toBeTruthy();

  // The regression: Settings displayed an API-origin ACS while the SP
  // advertised the web-origin ACS, so no IdP configuration could satisfy both.
  expect(new URL(settingsAcsUrl).href).toBe(new URL(advertisedAcsUrl).href);

  const acsPath = `/api/auth/sso/saml2/sp/acs/${encodeURIComponent(providerId)}`;

  // Delivery to the SP-advertised ACS (what mock Google actually does) must
  // clear the delivery policy. The unsigned assertion still fails Better
  // Auth's signature checks afterwards — but never as a destination mismatch.
  const advertisedDelivery = await postToAcs(den.ref, acsPath, googleSamlResponse({
    destination: advertisedAcsUrl,
    recipient: advertisedAcsUrl,
    audience,
  }));
  expect(advertisedDelivery.text).not.toContain("invalid_destination");
  expect(advertisedDelivery.text).not.toContain("invalid_recipient");

  // The policy must still fail closed on the same endpoint for responses
  // addressed to a foreign ACS.
  const foreignDelivery = await postToAcs(den.ref, acsPath, googleSamlResponse({
    destination: "https://attacker.example/acs",
    recipient: "https://attacker.example/acs",
    audience,
  }));
  expect(foreignDelivery.response.status, foreignDelivery.text).toBe(400);
  expect(foreignDelivery.text).toContain("invalid_destination");

  evidence.recordAssertionEvidence(
    "The SAML response delivery policy accepts the SP-advertised ACS URL and rejects foreign destinations",
    `Settings ACS ${settingsAcsUrl} matched the SP metadata ACS ${advertisedAcsUrl}; a mock Google response addressed there returned HTTP ${advertisedDelivery.response.status} without invalid_destination, while a response addressed to attacker.example returned HTTP ${foreignDelivery.response.status} with invalid_destination.`,
    new URL(settingsAcsUrl).href === new URL(advertisedAcsUrl).href
      && !advertisedDelivery.text.includes("invalid_destination")
      && !advertisedDelivery.text.includes("invalid_recipient")
      && foreignDelivery.response.status === 400
      && foreignDelivery.text.includes("invalid_destination"),
  );
});
