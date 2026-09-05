import { localMysqlIsRunning, SkipError } from "@openwork/env";
import type { Seed } from "@openwork/env";
import { waitFor } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
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

function booleanField(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Reflect.get(value, key) === true;
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
    const den = await seed.den({
      trustedOrigins: [new URL(idp.issuer).origin],
      org: { admin: { email: `sso-owner-${stamp}@${domain}` } },
    });
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

    const orgHeaders = {
      cookie: sessionCookie,
      "x-openwork-org-id": organizationId,
    };
    const createdTest = await seed.api(den.admin, "/v1/sso/test", {
      method: "POST",
      headers: orgHeaders,
      body: JSON.stringify({}),
    });
    const testUrl = stringField(createdTest.body, "testUrl");
    if (!createdTest.response.ok || !testUrl) {
      throw new Error(`Could not create the SSO configuration test: HTTP ${createdTest.response.status}.`);
    }

    const configurationWeb = await seed.web({ den, startPath: "/", headless: true });
    const cookieSeparator = sessionCookie.indexOf("=");
    if (cookieSeparator < 1) throw new Error("The SSO registration session cookie was malformed.");
    const configurationCookie = await configurationWeb.client.send("Network.setCookie", {
      name: sessionCookie.slice(0, cookieSeparator),
      value: sessionCookie.slice(cookieSeparator + 1),
      url: new URL(testUrl).origin,
      httpOnly: true,
    });
    if (!booleanField(configurationCookie, "success")) throw new Error("Could not apply the admin session to the SSO configuration test browser.");
    await configurationWeb.client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const apiOrigin = ${JSON.stringify(den.ref.apiUrl)};
        const originalFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const rawUrl = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
          const url = new URL(rawUrl, window.location.href);
          if (url.pathname.startsWith("/v1/sso/test/") && url.origin !== apiOrigin) {
            return originalFetch(new URL(url.pathname + url.search, apiOrigin), init);
          }
          return originalFetch(input, init);
        };
      })();`,
    });
    await navigate(configurationWeb.client, testUrl);
    await waitFor(configurationWeb, `/authentication test finished/i.test(document.body?.innerText ?? "")`, {
      timeoutMs: 90_000,
      label: "successful SSO configuration test",
    });

    let configurationTestStatus = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await seed.api(den.admin, "/v1/sso", { headers: orgHeaders });
      configurationTestStatus = stringField(recordField(current.body, "connection"), "testStatus");
      if (configurationTestStatus === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (configurationTestStatus !== "succeeded") {
      throw new Error(`The SSO configuration test did not succeed; last status was ${JSON.stringify(configurationTestStatus)}.`);
    }

    const enabled = await seed.api(den.admin, "/v1/sso/enable", {
      method: "POST",
      headers: orgHeaders,
      body: JSON.stringify({}),
    });
    if (enabled.response.status !== 204) throw new Error(`Could not enable the tested SSO connection: HTTP ${enabled.response.status}.`);

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
