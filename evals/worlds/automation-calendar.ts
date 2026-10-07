import { createNativeConnector, denFetch, type DenSession } from "@openwork/behaviors";
import { startMockGoogle } from "@openwork/labs";
import { localMysqlIsRunning, SkipError, type Place, type Seed } from "@openwork/env";
import { startCalendarMock } from "../packages/labs/src/calendar-mock.mjs";
import { enableOrganizationCapabilities } from "./dashboards.ts";
import { isRecord } from "./library.ts";

/**
 * The Workbot world's Acme organization (seed-demo-org, as preview-workbot boots it) with the owner's
 * Automations and two weeks of runs, and Alex's Google Calendar and Outlook connected for real: Den's native
 * calendar routes call the calendar mock's provider upstreams (Calendar v3, Graph calendarView) through
 * DEN_GOOGLE_API_BASE_URL / DEN_MICROSOFT_GRAPH_BASE_URL, after an OAuth sign-in against the mock identity
 * provider. The desktop reads meetings through Den exactly as with real accounts; nothing in the app is mocked.
 */
const ALEX = "alex@acme.test";
const TENANT = "12345678-1234-1234-1234-123456789abc";

async function connect(admin: DenSession, google: Awaited<ReturnType<typeof startMockGoogle>>, input: { providerKey: "google-workspace" | "microsoft-365"; name: string }) {
  const connection = await createNativeConnector(admin, {
    providerKey: input.providerKey, name: input.name, features: ["calendarRead"],
    clientId: `synthetic-${input.providerKey}`, clientSecret: "synthetic-calendar-secret",
  });
  const headers = { authorization: `Bearer ${admin.token}` };
  if (input.providerKey === "microsoft-365") {
    const configured = await denFetch(admin, `/v1/oauth-providers/${connection.id}/client`, { method: "POST", headers, body: JSON.stringify({ tenantId: TENANT }) });
    if (!configured.response.ok) throw new Error(`Microsoft tenant setup failed: HTTP ${configured.response.status} ${configured.text.slice(0, 300)}`);
  }
  const started = await denFetch(admin, `/v1/mcp-connections/${connection.id}/connect/start`, { headers });
  const authorizeUrl = isRecord(started.body) && typeof started.body.authorizeUrl === "string" ? started.body.authorizeUrl : "";
  if (!started.response.ok || !authorizeUrl) throw new Error(`${input.name} sign-in did not start: HTTP ${started.response.status}`);
  const authorize = new URL(authorizeUrl);
  if (authorize.origin !== new URL(google.authorizeUrl).origin) throw new Error("Refusing a non-witness authorization server");
  authorize.searchParams.set("prompt", "select_account");
  const chooser = await fetch(authorize, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  await chooser.text();
  await google.chooseAccount(ALEX, { timeoutMs: 30_000 });
  const status = await denFetch(admin, `/v1/oauth-providers/${connection.id}/status`, { headers });
  if (!isRecord(status.body) || status.body.connected !== true) throw new Error(`${input.name} did not connect: ${status.text.slice(0, 300)}`);
  return connection;
}

export async function automationCalendar(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("the demo-org seed and the calendar mock run next to a local Den");
  if (!await localMysqlIsRunning()) throw new SkipError("local MySQL for a disposable openwork_eval_ database");
  await using setup = new AsyncDisposableStack();
  const calendar = await startCalendarMock({ timeZone: "America/Los_Angeles" });
  setup.defer(() => calendar.stop());
  const identity = setup.use(await startMockGoogle({ accounts: [ALEX], port: 0 }));
  const den = await seed.den({
    web: true, seedProfile: "demo-org", seedAutomations: true,
    env: {
      RESEND_API_KEY: "", SMTP_HOST: "",
      DEN_GOOGLE_OAUTH_AUTHORIZE_URL: identity.authorizeUrl,
      DEN_GOOGLE_OAUTH_TOKEN_URL: identity.tokenUrl,
      DEN_GOOGLE_OAUTH_USERINFO_URL: identity.userinfoUrl,
      DEN_GOOGLE_API_BASE_URL: calendar.baseUrl,
      DEN_MICROSOFT_OAUTH_AUTHORIZE_URL: `${identity.authorizeUrl}?tenantId={tenantId}`,
      DEN_MICROSOFT_OAUTH_TOKEN_URL: `${identity.tokenUrl}?tenantId={tenantId}`,
      DEN_MICROSOFT_GRAPH_BASE_URL: `${calendar.baseUrl}/v1.0`,
    },
  });
  await enableOrganizationCapabilities(seed, den.admin, { automationCalendar: true });
  await connect(den.admin, identity, { providerKey: "google-workspace", name: "Google Workspace" });
  await connect(den.admin, identity, { providerKey: "microsoft-365", name: "Microsoft 365" });
  const desktop = await seed.desktop({ den, as: "admin", enterpriseActivated: true, name: "automation-calendar" });
  const resources = setup.move();
  return {
    den, desktop,
    /** Google starts rejecting Alex's token, as when a sign-in expires; Den answers 502 with the provider's 401. */
    async expireGoogleSignIn() {
      const response = await fetch(`${calendar.baseUrl}/scenario`, { method: "POST", body: JSON.stringify({ google: "expired_token" }) });
      if (!response.ok) throw new Error(`Calendar mock refused the scenario: HTTP ${response.status}`);
    },
    calendarRequests: () => calendar.state.requests.filter((request) => request.path.startsWith("/calendar/v3/") || request.path.startsWith("/v1.0/")).length,
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}
