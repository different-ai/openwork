import { denFetch, signIn, type DenSession } from "@openwork/behaviors";
import { queryDenDatabase, type Seed, type Place } from "@openwork/env";
import type { AttachedSurface } from "@openwork/cdp";
import { startBrowserSamlIdp } from "./saml-idp.ts";
import { record, rows, text } from "./org-invite.ts";

async function bootBrowser(seed: Seed, { place }: { place: Place }, mode: "optional" | "legacy" | "single") {
  if (place.kind !== "local") throw new Error("This proof owns loopback-only synthetic services; use --local.");
  if (process.env.OPENWORK_EVAL_DEN_API_URL) throw new Error("Do not attach this synthetic proof to an existing Den; unset OPENWORK_EVAL_DEN_API_URL.");
  const idp = await startBrowserSamlIdp();
  try {
    const stamp = Date.now().toString(36);
    const owner = { email: `owner@auth-${stamp}.example`, name: "Synthetic Owner", password: "Synthetic-Owner-Password-42!" };
    const den = await seed.den({
      org: { name: "Synthetic SSO organization", admin: owner }, trustedOrigins: [idp.origin],
      ...(mode === "single" ? { provision: false } : {}),
      env: { DEN_ORG_MODE: mode === "single" ? "single_org" : "multi_org", DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "true", DEN_PLAN_GATING_ENABLED: "false", DEN_REQUIRE_EMAIL_VERIFICATION: "false", RESEND_API_KEY: "", SMTP_HOST: "", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", STRIPE_SECRET_KEY: "", LOOPS_API_KEY: "" },
    });
    const request = (session: DenSession, path: string, init: RequestInit = {}) => denFetch(session, path, {
      ...init, headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json", ...init.headers }, signal: AbortSignal.timeout(20_000),
    });
    if (mode === "single") {
      const created = await denFetch(den.ref, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify(owner) });
      if (!created.response.ok) throw new Error(created.text);
      den.admin = await signIn(den.ref, owner);
    }
    const read = await request(den.admin, "/v1/org");
    const org = record(record(read.body).organization);
    const orgId = text(org.id);
    let otherId = orgId;
    let inviteToken = "";
    const invitee = { email: `invited@auth-${stamp}.example`, name: "Invited Teammate", password: "Synthetic-Invite-Password-42!" };
    if (mode !== "single") {
      const other = await request(den.admin, "/v1/org", { method: "POST", body: JSON.stringify({ name: "Synthetic other organization" }) });
      if (!other.response.ok) throw new Error(other.text);
      otherId = text(record(record(other.body).organization).id);
      const invited = await request(den.admin, "/v1/invitations", { method: "POST", headers: { "x-openwork-org-id": otherId }, body: JSON.stringify({ email: invitee.email, role: "member" }) });
      if (!invited.response.ok) throw new Error(invited.text);
      inviteToken = text(record(invited.body).inviteToken);
    }
    const browserLogin = await fetch(`${den.ref.apiUrl}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: den.ref.webUrl }, body: JSON.stringify({ email: owner.email, password: owner.password }) });
    const adminCookie = browserLogin.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const registration = await request(den.admin, "/v1/sso/saml", { method: "POST", headers: { "x-openwork-org-id": orgId, cookie: adminCookie }, body: JSON.stringify({ issuer: idp.origin, domain: `auth-${stamp}.example`, entryPoint: `${idp.origin}/sso`, cert: idp.cert, audience: den.ref.webUrl }) });
    if (!registration.response.ok) throw new Error(`Register synthetic SAML: ${registration.text}`);
    const providerId = text(record(record(registration.body).connection).providerId);
    if (!den.database) throw new Error("This proof requires its own disposable database");
    // Arrange only DNS ownership/configuration; every SSO session must come from
    // a browser AuthnRequest and a signed assertion. Never insert session proof.
    await queryDenDatabase(den.database.url, "UPDATE user SET email_verified=1 WHERE email=?", [owner.email]);
    await queryDenDatabase(den.database.url, "UPDATE sso_provider SET domain_verified=1 WHERE provider_id=?", [providerId]);
    await queryDenDatabase(den.database.url, "UPDATE sso_connection SET status='enabled', test_status='succeeded' WHERE provider_id=?", [providerId]);
    // ssoPerOrganization is on by default: the legacy world turns it off explicitly.
    const feature = await request(den.admin, `/v1/admin/organizations/${orgId}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities: { ssoPerOrganization: mode !== "legacy" } }) });
    if (!feature.response.ok) throw new Error(`Set fixture feature: ${feature.text}`);
    idp.configure({ audience: den.ref.webUrl, acs: `${den.ref.webUrl}/api/auth/sso/saml2/sp/acs/${providerId}`, email: owner.email });
    const activated = await request(den.admin, "/v1/me/active-organization", { method: "POST", body: JSON.stringify({ organizationId: orgId }) });
    if (!activated.response.ok) throw new Error(`Select the fixture's SSO organization: ${activated.text}`);
    const signedIn = den.admin;
    const web = await seed.web({ den, ...(mode === "single" ? { signedInAs: den.admin } : {}), startPath: mode === "single" ? "/dashboard/auth-security?tab=sso" : "/", headless: true, viewport: { width: 1440, height: 1000 } });
    const fresh = (path = "/", signedInAs?: DenSession) => seed.web({ den, ...(signedInAs ? { signedInAs } : {}), startPath: path, headless: true, viewport: { width: 1440, height: 1000 } });
    const sessionFor = async (surface: AttachedSurface): Promise<DenSession> => {
      const raw = await surface.client.send("Network.getCookies", { urls: [den.ref.webUrl] });
      const cookie = rows(record(raw).cookies).map((entry) => `${text(entry.name)}=${text(entry.value)}`).join("; ");
      const response = await fetch(`${den.ref.apiUrl}/api/auth/get-session`, { headers: { cookie }, signal: AbortSignal.timeout(15_000) });
      const payload: unknown = await response.json();
      return { ...signedIn, token: text(record(record(payload).session).token) };
    };
    return { den, web, orgId, orgSlug: text(org.slug), otherId, owner, invitee, invitePath: `/join-org?invite=${encodeURIComponent(inviteToken)}`, idp, fresh, sessionFor, request,
      async [Symbol.asyncDispose]() { await idp.close(); },
    };
  } catch (error) {
    await idp.close();
    throw error;
  }
}

export const ssoBrowser = (seed: Seed, context: { place: Place }) => bootBrowser(seed, context, "optional");
export const ssoLegacyBrowser = (seed: Seed, context: { place: Place }) => bootBrowser(seed, context, "legacy");
export const ssoSingleBrowser = (seed: Seed, context: { place: Place }) => bootBrowser(seed, context, "single");
