import { localMysqlIsRunning, SkipError } from "@openwork/env";
import type { Seed } from "@openwork/env";
import { startMockIdpLab } from "@openwork/labs";

function recordField(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const found = Reflect.get(value, key);
  return typeof found === "object" && found !== null && !Array.isArray(found) ? found : null;
}

function stringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const found = Reflect.get(value, key);
  return typeof found === "string" ? found : "";
}

export async function ssoInvite(seed: Seed) {
  if (!await localMysqlIsRunning()) throw new SkipError("MySQL on 127.0.0.1:3306");

  const stamp = Date.now();
  const domain = "sso-acme.test";
  const invitee = `sso-newcomer-${stamp}@${domain}`;
  const idp = await startMockIdpLab({
    domain,
    defaultSubject: { email: invitee, name: "SSO Newcomer" },
  });
  try {
    const den = await seed.den({ trustedOrigins: [new URL(idp.issuer).origin] });
    const organizationResult = await seed.api(den.admin, "/v1/org");
    const organizationId = stringField(recordField(organizationResult.body, "organization"), "id");
    if (!organizationResult.response.ok || !organizationId) {
      throw new Error(`Could not resolve the seeded organization: HTTP ${organizationResult.response.status}.`);
    }

    const signedIn = await seed.api(den.admin, "/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: den.admin.email, password: den.admin.password }),
    });
    const sessionCookie = signedIn.response.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "";
    if (!signedIn.response.ok || !sessionCookie) {
      throw new Error(`Could not create the SSO registration session: HTTP ${signedIn.response.status}.`);
    }

    const registration = idp.registration();
    const registered = await seed.api(den.admin, "/v1/sso/oidc", {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        "x-openwork-org-id": organizationId,
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
    if (!registered.response.ok) throw new Error(`Could not register SSO: HTTP ${registered.response.status}.`);

    const invited = await seed.api(den.admin, "/v1/invitations", {
      method: "POST",
      body: JSON.stringify({ email: invitee, role: "member" }),
    });
    const inviteToken = stringField(invited.body, "inviteToken");
    if (!invited.response.ok || !inviteToken) throw new Error(`Could not invite the SSO member: HTTP ${invited.response.status}.`);

    const webOrigin = den.ref.webUrl;
    const web = await seed.web({
      den,
      startPath: "/",
      headless: true,
      viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
    });
    return {
      web,
      invitee,
      joinUrl: `${webOrigin}/join-org?invite=${encodeURIComponent(inviteToken)}`,
      async [Symbol.asyncDispose]() {
        await idp[Symbol.asyncDispose]();
      },
    };
  } catch (error) {
    await idp[Symbol.asyncDispose]();
    throw error;
  }
}
