import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { evaluateOnSurface } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { z } from "zod";

const connectionSchema = z.object({
  providerId: z.string(), kind: z.enum(["saml", "oidc"]), domain: z.string(),
  signInUrl: z.string(), redirectUrl: z.string(), acsUrl: z.string().nullable(), metadataUrl: z.string().nullable(),
}).passthrough();
export function ssoConnection(body: unknown) {
  return z.object({ connection: connectionSchema.nullable() }).parse(body).connection;
}
export function manualOidc() {
  return { issuer: "https://idp.example.test/issuer", domain: "example.test", clientId: "example-client", clientSecret: "not-a-real-client-secret", skipDiscovery: true, authorizationEndpoint: "https://idp.example.test/authorize", tokenEndpoint: "https://idp.example.test/token", jwksEndpoint: "https://idp.example.test/jwks" };
}

async function ssoWorld(seed: Seed, saved: boolean) {
  const den = await seed.den({ web: true,
    ...(saved ? { publicOrigins: { web: "https://ow.ai.example.test", api: "https://api-ow.ai.example.test" } } : {}),
    org: { name: "Example Workspace", admin: { name: "Example Admin", email: "admin@example.test" }, members: {} },
  });
  const login = await fetch(`${den.ref.apiUrl}/api/auth/sign-in/email`, {
    method: "POST", headers: { "content-type": "application/json", origin: den.ref.webUrl },
    body: JSON.stringify({ email: den.admin.email, password: den.admin.password }),
  });
  if (login.status !== 200) throw new Error(`Fixture sign-in failed: HTTP ${login.status}`);
  const cookies = login.headers.getSetCookie();
  const cookie = cookies.map(value => value.split(";")[0]).join("; ");
  const headers = { cookie, authorization: `Bearer ${den.admin.token}`, "content-type": "application/json" };
  const cert = execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "/dev/null", "-out", "-", "-days", "1", "-subj", "/CN=idp.example.test"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let savedConnection: ReturnType<typeof ssoConnection> = null;
  if (saved) {
    const registered = await seed.api(den.admin, "/v1/sso/saml", { method: "POST", headers, body: JSON.stringify({
      issuer: "https://sts.windows.net/00000000-0000-0000-0000-000000000001/", domain: "example.test", entryPoint: "https://idp.example.test/sso", cert,
    }) });
    if (registered.response.status !== 201) throw new Error(`Fixture SAML save failed: HTTP ${registered.response.status}`);
    // Compare GET with GET: token bookkeeping after registration is not a UI write.
    const initial = await seed.api(den.admin, "/v1/sso", { headers });
    if (initial.response.status !== 200) throw new Error(`Fixture read failed: HTTP ${initial.response.status}`);
    savedConnection = ssoConnection(initial.body);
    if (!savedConnection) throw new Error("Fixture registration returned no connection");
  }
  const web = await seed.web({ den, signedInAs: "admin", startPath: "/dashboard/sso", headless: true, viewport: { width: 1440, height: 1800 } });
  // Arrange the real sign-in cookies as well as testkit's standard token handoff.
  // The non-blocking save proof must exercise an ordinary authenticated UI save.
  await web.client.send("Network.setCookies", { cookies: cookies.map(raw => {
    const pair = raw.split(";")[0]; const at = pair.indexOf("=");
    return { name: pair.slice(0, at), value: pair.slice(at + 1), url: den.ref.webUrl, httpOnly: true, secure: raw.toLowerCase().includes("; secure") };
  }) });
  await web.client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await web.client.send("Browser.grantPermissions", { origin: den.ref.webUrl, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  return {
    den, web, headers, cert, savedConnection,
    // Fixed read-only browser witnesses retain the original clipboard and DOM
    // checks without exposing a raw evaluation capability to the proof body.
    rows: () => evaluateOnSurface(web, () => Array.from(document.querySelectorAll<HTMLElement>("[data-sso-value]")).map(row => ({ key: row.dataset.ssoValue, label: row.querySelector("p")?.textContent, value: row.querySelector("code")?.textContent }))),
    clipboard: () => evaluateOnSurface(web, () => navigator.clipboard.readText()),
    setupPrecedesVerification: () => evaluateOnSurface(web, () => {
      const setup = document.querySelector('[data-testid="sso-provider-setup"]');
      const verification = document.querySelector('[data-testid="sso-domain-verification"], [data-testid="sso-domain-verified"]');
      if (!setup || !verification) throw new Error("Missing setup or verification block");
      return Boolean(setup.compareDocumentPosition(verification) & Node.DOCUMENT_POSITION_FOLLOWING);
    }),
  };
}
export function savedSamlValues(seed: Seed) { return ssoWorld(seed, true); }
export function emptySsoForm(seed: Seed) { return ssoWorld(seed, false); }

export async function initialAdministratorPassword(seed: Seed) {
  const code = randomUUID();
  const den = await seed.den({ provision: false, web: true, env: {
    DEN_ORG_MODE: "single_org", DEN_SINGLE_ORG_OWNER_EMAILS: "admin@example.test", DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "false", DEN_INITIAL_ADMIN_BOOTSTRAP_CODE: code,
  } });
  const web = await seed.web({ den, startPath: "/setup", headless: true, viewport: { width: 1440, height: 1000 } });
  const passwordState = () => evaluateOnSurface(web, () => {
    const input = document.querySelector("#setup-password");
    if (!(input instanceof HTMLInputElement)) throw new Error("Missing password input");
    return { min: input.minLength, max: input.maxLength, length: input.value.length,
      hint: document.querySelector("#setup-password-policy")?.textContent,
      error: document.querySelector("#setup-password-error")?.textContent ?? null,
      invalid: input.getAttribute("aria-invalid"), describedBy: input.getAttribute("aria-describedby"),
      customError: input.validity.customError, valid: input.checkValidity(),
      submitting: document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
    };
  });
  return {
    den, web, code, passwordState,
    authPosts: async () => (await den.apiLog()).split("\n").filter(line => {
      try { const entry: unknown = JSON.parse(line); return typeof entry === "object" && entry !== null && "http_method" in entry && entry.http_method === "POST" && "http_route" in entry && typeof entry.http_route === "string" && entry.http_route.startsWith("/api/auth/"); } catch { return false; }
    }).length,
    // The original independent React-guard regression deliberately dispatches a
    // submit event without native constraint validation. It neither rewrites
    // input/HTML nor fabricates a result; the proof independently observes the
    // preserved field, busy state and actual API POST count afterward.
    submitWithoutNativeValidation: () => evaluateOnSurface(web, async () => {
      const input = document.querySelector("#setup-password");
      if (!(input instanceof HTMLInputElement) || !input.form) throw new Error("Missing password form");
      input.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }),
  };
}
