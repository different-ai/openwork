import { startMockIdpLab } from "@openwork/labs";
import { randomBytes } from "node:crypto";
import { browserScript, evaluate } from "@openwork/cdp";
import type { Seed } from "@openwork/env";

async function bootInstallation(seed: Seed, restricted: boolean) {
  const email = restricted ? "outsider@outside.test" : "oidc-owner@example.test";
  const idp = await startMockIdpLab({
    defaultSubject: { email, name: restricted ? "Outside Member" : "Installation Owner" },
    knobs: { interactive: true },
  });
  try {
    const den = await seed.den({
      provision: false,
      org: { admin: { email: "oidc-owner@example.test" } },
      web: true,
      env: {
        DEN_DEPLOYMENT: "self_hosted",
        DEN_FEATURE_ENVIRONMENT_OIDC: "true",
        DEN_ORG_MODE: "single_org",
        DEN_SINGLE_ORG_OWNER_EMAILS: "oidc-owner@example.test",
        // Existing-org boundary fixture is provisioned through email signup;
        // the password-free bootstrap fixture leaves it disabled throughout.
        DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: restricted ? "true" : "false",
        OIDC_CLIENT_ID: idp.config.clientId,
        OIDC_CLIENT_SECRET: idp.config.clientSecret,
        OIDC_ISSUER_URL: idp.issuer,
        OIDC_PROVIDER_NAME: "Test identity",
        OIDC_TOKEN_AUTH_METHOD: "client_secret_post",
        RESEND_API_KEY: "", SMTP_HOST: "",
      },
    });
    if (restricted) {
      // The generic seed provisioner creates an organization explicitly, which
      // singleton deployments correctly forbid. A normal owner signup already
      // provisions the singleton through session creation.
      const signup = await seed.api(den.admin, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({
        name: "Fixture Owner", email: "oidc-owner@example.test", password: `${randomBytes(16).toString("base64url")}Aa1!`,
      }) });
      const token: unknown = signup.body && typeof signup.body === "object" ? Reflect.get(signup.body, "token") : null;
      if (!signup.response.ok || typeof token !== "string") throw new Error(`Could not arrange singleton owner: HTTP ${signup.response.status}; ${JSON.stringify(signup.body)}`);
      const update = await seed.api({ ...den.admin, token }, "/v1/org", { method: "PATCH", body: JSON.stringify({ allowedEmailDomains: ["example.test"] }) });
      if (!update.response.ok) throw new Error(`Could not configure allowed email domains: HTTP ${update.response.status}`);
    }
    const web = await seed.web({ den, startPath: "/", headless: true, viewport: { width: 1280, height: 900 } });
    return {
      den, web, email,
      // Cookie-session witness: bearer-based API probes cannot observe which
      // identity the browser actually authenticated through the callback.
      identity: () => evaluate(web.client, browserScript(async () => {
        const response = await fetch("/api/auth/get-session", { credentials: "include" });
        const payload = await response.json();
        return { email: payload?.user?.email ?? null, organizationId: payload?.session?.activeOrganizationId ?? null, hasSession: Boolean(payload?.session) };
      }, [])),
      async [Symbol.asyncDispose]() { await idp.stop(); },
    };
  } catch (error) { await idp.stop(); throw error; }
}

/** Password-free singleton bootstrap: only env config, no DB SSO arrangement. */
export function environmentOidc(seed: Seed) { return bootInstallation(seed, false); }

/** Existing organization policy must apply before admitting a new IdP user. */
export function restrictedEnvironmentOidc(seed: Seed) { return bootInstallation(seed, true); }
