import { denFetch, freshSession, signIn } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { isRecord } from "./openwork-server-cli.ts";

export const WORKSPACE_ORIGIN = "https://workspace.example.test:8787";
export const TYPED_ORIGIN = "https://Workspace.Example.test:8787/";
export const LOOKALIKE_ORIGINS = ["https://workspace.example.test.evil.test", "https://workspace.example.test:8788"];

const ORG_NAME = "Example Workspace Org";
const OUTSIDE_ORG_NAME = "Outside Example Org";
const SECOND_ORG_NAME = "Second Example Org";
const PASSWORD = "OpenWork-origins-4821!proof";

function field(value: unknown, key: string): string {
  const found = isRecord(value) ? value[key] : undefined;
  if (typeof found !== "string" || !found) throw new Error(`Missing ${key}`);
  return found;
}

async function activate(seed: Seed, session: DenSession, organizationId: string): Promise<void> {
  const result = await seed.api(session, "/v1/me/active-organization", {
    method: "POST", body: JSON.stringify({ organizationId }),
  });
  if (!result.response.ok) throw new Error(`Selecting the active organization failed: HTTP ${result.response.status}`);
}

export async function orgWebOrigins(seed: Seed) {
  const runId = Date.now().toString(36);
  const den = await seed.den({
    org: {
      name: ORG_NAME,
      admin: { name: "Olivia Owner", email: `owner-${runId}@example.test`, password: PASSWORD },
      members: {
        teammate: { name: "Taylor Teammate", email: `teammate-${runId}@example.test`, password: PASSWORD },
        orgAdmin: { name: "Avery Admin", email: `admin-${runId}@example.test`, password: PASSWORD },
      },
    },
  });
  const teammate = den.members.teammate;
  const orgAdmin = den.members.orgAdmin;
  if (!teammate || !orgAdmin) throw new Error("The testkit did not provision the teammate and admin sessions.");

  // Approving an origin requires a sign-in from the last 15 minutes; the owner's
  // browser uses this fresh session so the UI path never needs the re-auth dialog.
  const owner = await freshSession(den.admin);
  const orgs = await seed.api(owner, "/v1/me/orgs");
  const list = isRecord(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs : [];
  const orgId = field(list.find((org) => isRecord(org) && org.name === ORG_NAME), "id");
  const scope = { "x-openwork-org-id": orgId };

  const roster = await seed.api(owner, "/v1/org", { headers: scope });
  const members = isRecord(roster.body) && Array.isArray(roster.body.members) ? roster.body.members : [];
  const adminMemberId = field(members.find((member) => isRecord(member) && isRecord(member.user) && member.user.email === orgAdmin.email), "id");
  const promoted = await seed.api(owner, `/v1/members/${encodeURIComponent(adminMemberId)}/role`, {
    method: "POST", headers: scope, body: JSON.stringify({ role: "admin" }),
  });
  if (!promoted.response.ok) throw new Error(`Promoting the admin failed: HTTP ${promoted.response.status} ${promoted.text.slice(0, 300)}`);

  // A separate account that belongs only to its own organization.
  const outsiderPerson = { name: "Riley Outside", email: `outside-${runId}@example.test`, password: PASSWORD };
  const signUp = await denFetch(den.ref, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify(outsiderPerson) });
  if (!signUp.response.ok) throw new Error(`Outside account sign-up failed: HTTP ${signUp.response.status}`);
  const outsider = await signIn(den.ref, outsiderPerson);
  const outsideOrg = await seed.api(outsider, "/v1/org", { method: "POST", body: JSON.stringify({ name: OUTSIDE_ORG_NAME }) });
  if (!outsideOrg.response.ok || !isRecord(outsideOrg.body)) throw new Error(`Outside organization setup failed: HTTP ${outsideOrg.response.status}`);
  const outsideOrgId = field(outsideOrg.body.organization, "id");

  // The owner also belongs to a second organization, so a brand-new sign-in
  // session starts with no active organization (Den only preselects one when
  // a person belongs to exactly one). Nothing selects an org for this session.
  const secondOrg = await seed.api(owner, "/v1/org", { method: "POST", body: JSON.stringify({ name: SECOND_ORG_NAME }) });
  if (!secondOrg.response.ok) throw new Error(`Second organization setup failed: HTTP ${secondOrg.response.status}`);
  const ownerFreshSignIn = await signIn(den.ref, { email: den.admin.email, password: den.admin.password });

  await activate(seed, owner, orgId);
  await activate(seed, teammate, orgId);
  await activate(seed, orgAdmin, orgId);
  await activate(seed, outsider, outsideOrgId);

  const startPath = "/dashboard/org-settings";
  const ownerWeb = await seed.web({ den, signedInAs: owner, startPath, headless: true, viewport: { width: 1440, height: 1000 } });
  const adminWeb = await seed.web({ den, signedInAs: orgAdmin, startPath, headless: true, viewport: { width: 1440, height: 1000 } });
  const ownerPhone = await seed.web({ den, signedInAs: owner, startPath, headless: true, viewport: { width: 390, height: 844 } });

  return {
    den, orgId, outsideOrgId, owner, ownerFreshSignIn, teammate, orgAdmin, outsider, ownerWeb, adminWeb, ownerPhone,
    /** The active organization a session reports and how many it belongs to. */
    async sessionOrgs(session: DenSession) {
      const result = await seed.api(session, "/v1/me/orgs");
      const body = isRecord(result.body) ? result.body : {};
      return {
        activeOrgId: typeof body.activeOrgId === "string" ? body.activeOrgId : null,
        count: Array.isArray(body.orgs) ? body.orgs.length : 0,
      };
    },
    /** The organization a web instance lands in after exchanging the one-time grant from a handoff. */
    async exchange(grant: string) {
      const result = await denFetch(den.ref, "/v1/auth/desktop-handoff/exchange", { method: "POST", body: JSON.stringify({ grant }) });
      const body = isRecord(result.body) ? result.body : {};
      return { status: result.response.status, organizationId: isRecord(body.organization) && typeof body.organization.id === "string" ? body.organization.id : null };
    },
    /**
     * What a person's browser receives when Den is asked to send them back to
     * returnUrl after sign-in. This mints a one-time grant, so it lives here
     * rather than in probe.api (GET-only).
     */
    async handoff(session: DenSession, returnUrl: string) {
      const result = await denFetch(session, "/v1/auth/desktop-handoff", {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ returnUrl }),
      });
      const body = isRecord(result.body) ? result.body : {};
      return {
        status: result.response.status,
        returnUrl: typeof body.returnUrl === "string" ? body.returnUrl : null,
        grant: typeof body.grant === "string" ? body.grant : null,
        error: typeof body.error === "string" ? body.error : null,
      };
    },
    /** The CORS preflight a page on `origin` sends before a credentialed call to Den. */
    async preflight(origin: string) {
      // TODO(primitive): probe.api is GET-only; a browser preflight needs OPTIONS with a foreign Origin.
      const response = await fetch(new URL("/v1/me/orgs", den.ref.apiUrl), {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
        signal: AbortSignal.timeout(15_000),
      });
      await response.body?.cancel();
      return {
        status: response.status,
        allowOrigin: response.headers.get("access-control-allow-origin"),
        allowCredentials: response.headers.get("access-control-allow-credentials"),
      };
    },
  };
}
