import type { Seed } from "@openwork/env";
import { connect, debuggerUrlFor, listTargets, setViewport, type Surface } from "@openwork/cdp";
import { chrome, daytonaSandbox, defaultDaytonaExec, execInSandbox } from "@openwork/hosts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected response object");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected nonempty string");
  return value;
}
const sqlString = (value: string) => `CONVERT(0x${Buffer.from(value).toString("hex")} USING utf8mb4)`;

/** A real Den, browser, and signed-token OIDC provider on disposable Daytona hosts. */
export async function reauthPopup(seed: Seed) {
  const stamp = Date.now();
  const domain = `reauth-${stamp}.test`;
  const originalName = `SSO verification ${stamp}`;
  const den = await seed.den({ env: { DEN_BETTER_AUTH_COOKIE_DOMAIN: "daytonaproxy01.net" }, org: { name: originalName, admin: { email: `admin@${domain}`, name: "SSO Admin" } } });
  if (den.placement?.kind !== "daytona") throw new Error("This journey requires Daytona placement");
  const sandbox = den.placement.sandboxId;
  const remote = async (script: string, timeoutMs = 30_000) => (await execInSandbox(defaultDaytonaExec, sandbox, script, { timeoutMs, context: "SSO fixture arrangement" })).stdout;
  const sql = async (statement: string) => remote(`echo ${Buffer.from(statement).toString("base64")} | base64 -d | mysql -h127.0.0.1 -uroot -ppassword -N openwork_den`);
  const preview = await defaultDaytonaExec(["preview-url", sandbox, "-p", "19190", "--expires", "86400"]);
  if (preview.code !== 0) throw new Error("Could not expose test IdP");
  const issuer = new URL(text(preview.stdout.match(/https:\/\/[^\s]+/)?.[0])).origin;
  const fixtureSource = `import { startMockIdpLab } from "/workspace/evals/packages/labs/src/idp.ts"; await startMockIdpLab(${JSON.stringify({ domain, defaultSubject: { email: den.admin.email, name: "SSO Admin" }, publicIssuer: issuer, listen: { host: "0.0.0.0", port: 19190 }, knobs: { interactive: true } })});`;
  await remote(`echo ${Buffer.from(fixtureSource).toString("base64")} | base64 -d > /tmp/reauth-idp.mjs`);
  await remote(`python3 - <<PY
import subprocess
with open("/tmp/reauth-idp.log", "ab", buffering=0) as log:
 subprocess.Popen(["node", "/tmp/reauth-idp.mjs"], stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)
PY`);
  const orgResult = await seed.api(den.admin, "/v1/org");
  const organizationId = text(record(record(orgResult.body).organization).id);
  const signIn = await seed.api(den.admin, "/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email: den.admin.email, password: den.admin.password }) });
  if (!signIn.response.ok) throw new Error(`Fixture login: ${signIn.response.status}`);
  const sessionCookie = text(signIn.response.headers.getSetCookie().find((value) => value.includes("session_token=")));
  const cookie = text(sessionCookie.split(";")[0]);
  const headers = { cookie, "x-openwork-org-id": organizationId };
  const registration = await seed.api(den.admin, "/v1/sso/oidc", {
    method: "POST", headers,
    body: JSON.stringify({ issuer, domain, clientId: "openwork-eval-oidc-client", clientSecret: "openwork-eval-oidc-secret", scopes: ["openid", "email", "profile"], skipDiscovery: true, authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`, jwksEndpoint: `${issuer}/jwks`, userInfoEndpoint: `${issuer}/userinfo`, tokenEndpointAuthentication: "client_secret_post" }),
  });
  if (!registration.response.ok) throw new Error(`SSO registration: ${registration.response.status} ${registration.text}`);
  // Synthetic .test domains cannot publish DNS; only domain ownership is arranged.
  // Configuration testing, enabling, login, and privileged-session freshness use the real server.
  await sql(`UPDATE sso_provider SET domain_verified=1 WHERE organization_id=${sqlString(organizationId)};`);
  const configTest = await seed.api(den.admin, "/v1/sso/test", { method: "POST", headers, body: "{}" });
  if (!configTest.response.ok) throw new Error(`Configuration test: ${configTest.response.status} ${configTest.text}`);
  const testUrl = text(record(configTest.body).testUrl);
  await remote("command -v chromium >/dev/null || (sudo apt-get update >/tmp/reauth-browser-install.log 2>&1 && sudo apt-get install -y chromium >>/tmp/reauth-browser-install.log 2>&1)", 180_000);
  const host = daytonaSandbox(sandbox);
  const web = await chrome({ host, name: "reauth-browser", startUrl: den.ref.webUrl, headless: true });
  await setViewport(web, { width: 1440, height: 1000, deviceScaleFactor: 1 });
  const separator = cookie.indexOf("=");
  const cookieDomain = sessionCookie.match(/;\s*Domain=([^;]+)/i)?.[1];
  if (!cookieDomain) throw new Error("The fixture requires the same shared-domain cookie topology as production");
  await web.client.send("Network.setCookie", { name: cookie.slice(0, separator), value: cookie.slice(separator + 1), domain: cookieDomain, path: "/", url: den.ref.webUrl, httpOnly: true, secure: true });
  return {
    den, web, originalName, testUrl, issuer, organizationId, otherEmail: `other@${domain}`,
    async [Symbol.asyncDispose]() {
      await web.stop();
      await host.stop();
    },
    async enable() {
      const result = await seed.api(den.admin, "/v1/sso/enable", { method: "POST", headers, body: "{}" });
      if (result.response.status !== 204) throw new Error(`SSO enable: ${result.response.status} ${result.text}`);
    },
    async ageSession() {
      await sql(`UPDATE session SET created_at=DATE_SUB(NOW(3), INTERVAL 20 MINUTE) WHERE user_id IN (SELECT id FROM user WHERE email=${sqlString(den.admin.email)});`);
    },
    async storedName() {
      return (await sql(`SELECT name FROM organization WHERE id=${sqlString(organizationId)};`)).trim();
    },
    async popup(): Promise<Surface | null> {
      const target = (await listTargets(web.handle.cdpUrl)).find((entry) => entry.type === "page" && entry.id !== web.client.targetId && entry.url.startsWith(issuer));
      if (!target) return null;
      return { handle: web.handle, client: await connect(debuggerUrlFor(web.handle.cdpUrl, target)) };
    },
    async popupCount() {
      return (await listTargets(web.handle.cdpUrl)).filter((entry) => entry.type === "page" && entry.id !== web.client.targetId).length;
    },
    async closePopup(popup: Surface) {
      await web.client.send("Target.closeTarget", { targetId: popup.client.targetId });
      popup.client.close();
    },
    async blockPopups(blocked: boolean) {
      // Browser fault injection only; no authentication response or application state is mocked.
      await web.client.send("Runtime.evaluate", { expression: blocked
        ? "window.__reauthOriginalOpen = window.open; window.open = () => null"
        : "window.open = window.__reauthOriginalOpen; delete window.__reauthOriginalOpen" });
    },
    async sendCompletion(kind: "wrong-nonce" | "foreign-origin" | "stale") {
      await web.client.send("Runtime.evaluate", { expression: `window.dispatchEvent(new MessageEvent("message", { origin: ${kind === "foreign-origin" ? '"https://foreign.example.test"' : 'location.origin'}, data: { type: "openwork:reauth-complete", nonce: ${kind === "wrong-nonce" ? '"unrelated"' : 'document.querySelector("[data-reauth-nonce]").dataset.reauthNonce'}, error: null } }))` });
    },
  };
}
