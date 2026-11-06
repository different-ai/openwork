import { denFetch, type DenSession } from "@openwork/behaviors";
import { queryDenDatabase, type Place, type Seed } from "@openwork/env";
import { defaultDaytonaExec, execInSandbox } from "@openwork/hosts";
import { record, text } from "./org-invite.ts";

/**
 * multipleSsoConnections: an organization with three SSO connections. Okta and
 * Microsoft Entra ID cover the main domain (Entra also a subsidiary's); a
 * third for a partner's domain still waits for its DNS check. Connections are
 * registered through the real routes; only DNS ownership, the administrator's
 * connection test and enabling are arranged, since no identity provider runs
 * here. Nothing in this world signs anyone in through SSO. Runs against a
 * local Den or a Den sandbox on Daytona.
 */
export async function ssoMultipleConnections(seed: Seed, _context: { place: Place }) {
  const stamp = Date.now().toString(36);
  const mainDomain = `auth-${stamp}.example`;
  const subsidiaryDomain = `sub-${stamp}.example`;
  const partnerDomain = `partner-${stamp}.example`;
  const owner = { email: `owner@${mainDomain}`, name: "Synthetic Owner", password: "Synthetic-Owner-Password-42!" };
  const den = await seed.den({
    org: { name: "Synthetic SSO organization", admin: owner },
    env: { DEN_ORG_MODE: "multi_org", DEN_PLAN_GATING_ENABLED: "false", DEN_REQUIRE_EMAIL_VERIFICATION: "false", RESEND_API_KEY: "", SMTP_HOST: "", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", STRIPE_SECRET_KEY: "", LOOPS_API_KEY: "" },
  });
  const placement = den.placement ?? { kind: "local" as const };

  /** ARRANGE ONLY: one statement on Den's database, wherever it runs. Values are ids and fixed words. */
  async function arrangeSql(statement: string, values: string[]) {
    if (placement.kind === "local") {
      if (!den.database) throw new Error("This proof requires its own disposable database");
      await queryDenDatabase(den.database.url, statement, values);
      return;
    }
    if (values.some((value) => !/^[A-Za-z0-9_-]+$/.test(value))) throw new Error("Unsafe SQL value");
    let index = 0;
    const literal = statement.replace(/\?/g, () => `\\"${values[index++] ?? ""}\\"`);
    await execInSandbox(defaultDaytonaExec, placement.sandboxId, `mysql -h127.0.0.1 -uroot -ppassword openwork_den -e "${literal}"`, { timeoutMs: 60_000, context: "arrange SSO connection state" });
  }
  const request = (session: DenSession, path: string, init: RequestInit = {}) => denFetch(session, path, {
    ...init, headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json", ...init.headers }, signal: AbortSignal.timeout(20_000),
  });
  const read = await request(den.admin, "/v1/org");
  const org = record(record(read.body).organization);
  const orgId = text(org.id);
  const orgSlug = text(org.slug);
  for (const capability of ["multipleSsoConnections", "ssoPerOrganization"]) {
    const feature = await request(den.admin, `/v1/admin/organizations/${orgId}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities: { [capability]: true } }) });
    if (!feature.response.ok) throw new Error(`Turn on ${capability}: ${feature.text}`);
  }
  const browserLogin = await fetch(`${den.ref.apiUrl}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: den.ref.webUrl }, body: JSON.stringify({ email: owner.email, password: owner.password }) });
  const adminCookie = browserLogin.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

  async function addConnection(input: { name: string; issuer: string; domains: string[] }) {
    const body = {
      name: input.name,
      issuer: input.issuer,
      domains: input.domains,
      clientId: `client-${stamp}`,
      clientSecret: `secret-${stamp}`,
      skipDiscovery: true,
      authorizationEndpoint: `${input.issuer}/authorize`,
      tokenEndpoint: `${input.issuer}/token`,
      jwksEndpoint: `${input.issuer}/keys`,
    };
    const created = await request(den.admin, "/v1/sso/connections/oidc", { method: "POST", headers: { "x-openwork-org-id": orgId, cookie: adminCookie }, body: JSON.stringify(body) });
    if (!created.response.ok) throw new Error(`Add ${input.name}: ${created.text}`);
    const connection = record(record(created.body).connection);
    return { id: text(connection.id), providerId: text(connection.providerId) };
  }

  /** ARRANGE ONLY: DNS ownership proven, the administrator's test passed, and the connection turned on. */
  async function arrangeEnabled(providerId: string) {
    await arrangeSql("UPDATE sso_provider SET domain_verified=1 WHERE provider_id=?", [providerId]);
    await arrangeSql("UPDATE sso_connection SET status=?, test_status=?, last_tested_revision=config_revision, last_tested_at=NOW(3) WHERE provider_id=?", ["enabled", "succeeded", providerId]);
  }

  const okta = await addConnection({ name: "Okta", issuer: `https://synthetic-${stamp}.okta.com`, domains: [mainDomain] });
  await arrangeEnabled(okta.providerId);
  const entra = await addConnection({ name: "Microsoft Entra ID", issuer: `https://idp-entra-${stamp}.example.test`, domains: [mainDomain, subsidiaryDomain] });
  await arrangeEnabled(entra.providerId);
  const partner = await addConnection({ name: "Partner Google Workspace", issuer: `https://idp-partner-${stamp}.example.test`, domains: [partnerDomain] });

  const activated = await request(den.admin, "/v1/me/active-organization", { method: "POST", body: JSON.stringify({ organizationId: orgId }) });
  if (!activated.response.ok) throw new Error(`Select the SSO organization: ${activated.text}`);
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/sso", headless: true, viewport: { width: 1440, height: 1000 } });
  const signedOut = (path = "/") => seed.web({ den, startPath: path, headless: true, viewport: { width: 1440, height: 1000 } });
  return { den, web, signedOut, request, orgId, orgSlug, owner, mainDomain, subsidiaryDomain, partnerDomain, okta, entra, partner };
}
