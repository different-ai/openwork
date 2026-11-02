import { expect } from "vitest";
import { spec, type SpecBodyContext } from "@openwork/testkit";
import { z } from "zod";
import { singleOriginOidcRedirect, splitOriginOidcRedirect } from "../worlds/sso-oidc-redirect.ts";

const single = spec.world(singleOriginOidcRedirect, { resources: { surfaces: [], services: ["den"] }, timeout: 300_000 });
const split = spec.world(splitOriginOidcRedirect, { resources: { surfaces: [], services: ["den"] }, timeout: 300_000 });
const connectionPayload = z.object({ connection: z.object({
  providerId: z.string(), kind: z.literal("oidc"), redirectUrl: z.string().url(),
  acsUrl: z.null(), metadataUrl: z.null(), domainVerified: z.boolean(), status: z.literal("disabled"),
}) });

async function proveCallback({ world, step, evidence }: SpecBodyContext<Awaited<ReturnType<typeof singleOriginOidcRedirect>>>) {
  const { den, webOrigin: web, apiOrigin: api } = world;
  // This browser-less client proof uses the real public API and installed Better
  // Auth plugin. It never opens the generated URL or contacts an external IdP.
  const login = await fetch(`${den.ref.apiUrl}/api/auth/sign-in/email`, {
    method: "POST", headers: { "content-type": "application/json", origin: den.ref.webUrl },
    body: JSON.stringify({ email: den.admin.email, password: den.admin.password }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const headers = { cookie, authorization: `Bearer ${den.admin.token}`, "content-type": "application/json" };

  await step("an administrator saves a disabled OIDC connection through the public API", async () => {
    const saved = await fetch(`${den.ref.apiUrl}/v1/sso/oidc`, { method: "POST", headers, body: JSON.stringify({
      issuer: "http://127.0.0.1:19876", domain: "example.test", clientId: "example-client", clientSecret: "not-a-real-secret",
      skipDiscovery: true, authorizationEndpoint: "https://idp.example.test/authorize", tokenEndpoint: "https://idp.example.test/token", jwksEndpoint: "https://idp.example.test/jwks",
    }) });
    expect(saved.status).toBe(201);
    evidence.recordAssertionEvidence("the authenticated administrator can save OIDC without enabling it", `sign-in HTTP ${login.status}; save HTTP ${saved.status}`, login.status === 200 && saved.status === 201);
  });

  const read = await fetch(`${den.ref.apiUrl}/v1/sso`, { headers });
  expect(read.status).toBe(200);
  const { connection } = connectionPayload.parse(await read.json());
  await step("the client receives an OIDC callback, never SAML setup values", async () => {
    expect(connection.domainVerified).toBe(true);
    expect(new URL(connection.redirectUrl).pathname).not.toContain("/saml2/");
    evidence.recordAssertionEvidence("the saved public contract stays disabled and OIDC-only", `GET HTTP ${read.status}; kind=${connection.kind}; status=${connection.status}; SAML ACS=${connection.acsUrl}; metadata=${connection.metadataUrl}`, read.status === 200 && connection.status === "disabled" && connection.acsUrl === null && connection.metadataUrl === null);
  });

  const intentResponse = await fetch(`${den.ref.apiUrl}/v1/sso/test`, { method: "POST", headers, body: "{}" });
  expect(intentResponse.status).toBe(201);
  const { intentId } = z.object({ intentId: z.string() }).parse(await intentResponse.json());
  try {
    await step("after: the displayed callback equals the runtime request on the auth host", async () => {
      const start = await fetch(`${den.ref.apiUrl}/v1/sso/test/${encodeURIComponent(intentId)}/start`, { method: "POST", headers, body: "{}" });
      expect(start.status).toBe(200);
      const started = z.object({ url: z.string().url() }).parse(await start.json());
      // Only the public redirect URI is retained, never state, nonce or the
      // complete authorization URL returned by the real plugin.
      const emitted = new URL(started.url).searchParams.get("redirect_uri");
      const expected = `${web}/api/auth/sso/callback/${encodeURIComponent(connection.providerId)}`;
      expect(emitted).toBe(expected);
      expect(connection.redirectUrl).toBe(emitted);
      if (world.split) expect(new URL(connection.redirectUrl).origin).not.toBe(api);
      evidence.recordAssertionEvidence("copying the advertised URL registers the callback actually requested", `advertised=${connection.redirectUrl}; emitted=${emitted}; separate API host=${world.split}`, emitted === expected && connection.redirectUrl === emitted && (!world.split || new URL(connection.redirectUrl).origin !== api));
    });
  } finally {
    const canceled = await fetch(`${den.ref.apiUrl}/v1/sso/test/${encodeURIComponent(intentId)}/cancel`, { method: "POST", headers, body: "{}" });
    expect(canceled.status).toBe(204);
  }
}

single("displayed OIDC callback equals Better Auth's emitted redirect_uri (single origin)", proveCallback);
split("displayed OIDC callback equals Better Auth's emitted redirect_uri (split origin)", proveCallback);
