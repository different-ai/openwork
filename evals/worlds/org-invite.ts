import { denFetch, signIn, type DenSession } from "@openwork/behaviors";
import { selfHostServer } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { allocateFreePorts, type AttachedSurface } from "@openwork/cdp";
import { defaultReuseAdmin, faultProxy, localMysqlIsRunning, localRedisIsRunning, needs, personDefaults, queryDenDatabase, SkipError, type Place, type Seed } from "@openwork/env";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object witness");
  return value;
}

export function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty string witness");
  return value;
}

export function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected an array witness");
  return value.map(record);
}

export async function localInviteNeeds() {
  needs({ placement: "local" });
  if (!await localMysqlIsRunning()) throw new SkipError("MySQL on 127.0.0.1:3306");
  if (!await localRedisIsRunning()) throw new SkipError("Redis on 127.0.0.1:6379");
}

export function invitationWitnesses(admin: DenSession) {
  const api = (path: string, init?: RequestInit) => denFetch(admin, path, {
    ...init,
    headers: { authorization: `Bearer ${admin.token}`, ...init?.headers },
    signal: AbortSignal.timeout(15_000),
  });
  const read = async (path: string, orgId?: string) => {
    const result = await api(path, { headers: orgId ? { "x-openwork-org-id": orgId } : {} });
    if (!result.response.ok) throw new Error(`Witness ${path}: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
    return record(result.body);
  };
  const emails = async (template: string, email: string) => rows((await read(`/v1/dev/emails?template=${template}`)).emails).filter((entry) => entry.to === email);
  const lastEmail = async (template: string, email: string) => {
    const all = rows((await read(`/v1/dev/emails?template=${template}`)).emails);
    if (all[0]?.to !== email) throw new Error(`Latest ${template} email does not belong to the isolated recipient ${email}`);
    const result = await api(`/v1/dev/emails/last?template=${template}`);
    if (!result.response.ok) throw new Error(`Email HTML: HTTP ${result.response.status}`);
    return result.text;
  };
  return {
    api, emails, lastEmail,
    sessionFor: (person: { email: string; password: string }) => signIn(admin, person),
    org: (id?: string) => read("/v1/org", id),
    orgs: async () => rows((await read("/v1/me/orgs")).orgs),
    async invite(email: string, orgId: string, role = "member") {
      const result = await api("/v1/invitations", {
        method: "POST", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({ email, role }),
      });
      if (!result.response.ok) throw new Error(`Create invitation: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
      const body = record(result.body);
      const html = await lastEmail("organizationInvite", email);
      const link = emailLinks(html).find((url) => new URL(url).pathname === "/join-org");
      if (!link || new URL(link).searchParams.get("invite") !== body.inviteToken) throw new Error("Invitation email must contain the issued invitation link");
      return { id: text(body.invitationId), token: text(body.inviteToken), link, email, role, orgId };
    },
    async otp(email: string) {
      const html = await lastEmail("verification", email);
      const code = html.replace(/<[^>]*>/g, " ").match(/\b\d{6}\b/)?.[0];
      if (!code) throw new Error("Verification email has no six-digit code");
      return code;
    },
  };
}

// An anonymous email sign-up, as a visitor without an invitation would send it.
export function signUpAttempt(den: Parameters<typeof denFetch>[0], person: { email: string; name: string; password: string }) {
  return denFetch(den, "/api/auth/sign-up/email", {
    method: "POST", body: JSON.stringify(person), signal: AbortSignal.timeout(15_000),
  });
}

export function emailLinks(html: string): string[] {
  return [...html.matchAll(/href=["'](https?:\/\/[^"']+)["']/g)].map((match) => match[1].replaceAll("&amp;", "&"));
}

export function membersFor(org: Record<string, unknown>, email: string) {
  return rows(org.members).filter((member) => member.userId && member.joinedAt && member.user && record(member.user).email === email);
}

export function invitationsFor(org: Record<string, unknown>, email: string) {
  return rows(org.invitations).filter((invitation) => invitation.email === email);
}

/** An owner on Members with one pending invitation, and a teammate who joined as a plain member. */
export async function orgInviteLink(seed: Seed) {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const den = await seed.den({
    org: { name: `Invite Link Lab ${runId}`, admin: { name: "Link Owner" }, members: { teammate: { name: "Link Teammate" } } },
  });
  const teammate = den.members.teammate;
  if (!teammate) throw new Error("The teammate was not provisioned");
  const email = `pending-link+${runId}@openwork.test`;
  const created = await seed.api(den.admin, "/v1/invitations", { method: "POST", body: JSON.stringify({ email, role: "member" }) });
  if (!created.response.ok) throw new Error(`Create invitation: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
  const issued = record(created.body);
  const invitation = { id: text(issued.invitationId), token: text(issued.inviteToken), email };
  const context = await seed.api(den.admin, "/v1/org");
  if (!context.response.ok) throw new Error(`Organization: HTTP ${context.response.status}`);
  const organizationId = text(record(record(context.body).organization).id);
  const pendingMember = rows(record(context.body).members).find((member) => member.inviteId === invitation.id);
  const pendingName = text(record(pendingMember?.user).name);
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/members", headless: true, viewport: { width: 1440, height: 1000 } });
  // TODO(primitive): seed needs a browser-permission helper (as in den-download-openwork).
  // Grant the real permission so a successful copy is the browser's own clipboard.
  await web.client.send("Browser.grantPermissions", {
    origin: new URL(den.ref.webUrl).origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  return {
    den, web, teammate, invitation, organizationId, pendingName,
    // TODO(primitive): probe.clipboard should expose this read-only witness without browser evaluation.
    readClipboard: () => seed.evalIn(web, () => navigator.clipboard.readText(), { awaitPromise: true }),
  };
}

/**
 * Locally, den-web reaches den-api through a fault proxy pinned before boot,
 * so a browser stays on Den's real origin while a test fails one API call.
 * Serving den-web itself from the proxy's port leaves the join page loading.
 */
async function pinnedLocalFaultProxy(place: Place) {
  if (place.kind !== "local") return null;
  const [apiPort, webPort] = await allocateFreePorts(2);
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const proxy = await faultProxy({ apiUrl, webUrl: apiUrl }, { place });
  return { proxy, ports: { api: apiPort, web: webPort } };
}

/**
 * The join pages draw an animated WebGL background. Headless Chrome on CI has
 * no GPU, so every open join page rendered it in software on each frame and
 * slowed every click in the journey several times over. Reduced motion draws
 * the same background once; nothing the journey checks depends on the motion.
 */
async function stillBackground(surface: AttachedSurface): Promise<AttachedSurface> {
  await surface.client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  return surface;
}

export async function orgInvite(seed: Seed, { place }: { place: Place }) {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const identity = (key: string) => personDefaults(key, undefined, runId);
  const pinned = await pinnedLocalFaultProxy(place);
  const den = await seed.den({
    ...(place.kind === "daytona" ? { provision: false } : { seedProfile: "demo-org" }),
    ...(pinned ? { ports: pinned.ports, webApiBase: pinned.proxy.ref.webUrl } : {}),
    env: {
      DEN_ORG_MODE: "multi_org", DEN_REQUIRE_EMAIL_VERIFICATION: "true",
      DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "true", OPENWORK_DEV_MODE: "1",
      RESEND_API_KEY: "", SMTP_HOST: "", GOOGLE_CLIENT_ID: "invite-google-client", GOOGLE_CLIENT_SECRET: "invite-google-secret",
    },
  });
  const owner = await signIn(den.ref, defaultReuseAdmin());
  den.admin = owner;
  const witnesses = invitationWitnesses(owner);
  const createdOrganization = await seed.api(owner, "/v1/org", { method: "POST", body: JSON.stringify({ name: `Invite workspace ${runId}` }) });
  if (!createdOrganization.response.ok) throw new Error(`Organization: HTTP ${createdOrganization.response.status}`);
  const organization = record(record(createdOrganization.body).organization);
  // Signing up from this workspace's invite links verifies the invited email (OPE-82).
  await enableOrganizationCapabilities(seed, owner, { inviteLinkVerifiesEmail: true }, text(organization.id));
  const createdOther = await seed.api(owner, "/v1/org", { method: "POST", body: JSON.stringify({ name: `Other workspace ${runId}` }) });
  if (!createdOther.response.ok) throw new Error(`Second organization: HTTP ${createdOther.response.status}`);
  const otherOrg = record(record(createdOther.body).organization);
  const selected = await seed.api(owner, "/v1/me/active-organization", {
    method: "POST", body: JSON.stringify({ organizationId: text(organization.id) }),
  });
  if (!selected.response.ok) throw new Error(`Select organization: HTTP ${selected.response.status}`);
  const other = owner;
  // The same account in its own session, for a browser that signs out: signing
  // out revokes that session, and the witnesses keep using the owner's.
  const otherBrowser = await signIn(den.ref, defaultReuseAdmin());
  const web = await stillBackground(await seed.web({ den, startPath: "/", headless: true }));
  return {
    den, web, owner, other, otherBrowser, organization, otherOrg, identity, witnesses,
    fresh: async (startPath = "/", signedInAs?: DenSession) => stillBackground(await seed.web({ den, startPath, signedInAs, headless: true })),
    /** A browser at startPath whose Den API calls go through a fault proxy the test controls. */
    async faultableWeb(startPath: string) {
      if (pinned) return { proxy: pinned.proxy, surface: await stillBackground(await seed.web({ den, startPath, headless: true })) };
      const proxy = await seed.faultProxy(den);
      return { proxy, surface: await stillBackground(await seed.web({ den: { ...den, ref: proxy.ref }, startPath, headless: true })) };
    },
    async [Symbol.asyncDispose]() {
      await pinned?.proxy[Symbol.asyncDispose]();
    },
    // A sign-up that stopped at the emailed code: the account and password
    // exist, the email is unverified, and Den created no session.
    async unverifiedAccount(person: { email: string; name: string; password: string }) {
      const result = await denFetch(den.ref, "/api/auth/sign-up/email", {
        method: "POST", body: JSON.stringify({ name: person.name, email: person.email, password: person.password }),
      });
      if (!result.response.ok || record(result.body).token !== null) {
        throw new Error(`Unverified sign-up: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
      }
    },
    async sessionsFor(email: string) {
      if (!den.database) throw new Error("Session witness requires the isolated Den database");
      return queryDenDatabase(den.database.url, "SELECT session.id FROM session INNER JOIN user ON user.id = session.user_id WHERE user.email = ? AND session.expires_at > NOW()", [email]);
    },
  };
}

/**
 * Option of this world: a private self-hosted Den (public signup off) whose
 * configured administrator claimed it with a one-time bootstrap code. The
 * journey checks what that claim produced.
 */
export async function privateSelfHostInvite(seed: Seed, { place }: { place: Place }) {
  await localInviteNeeds();
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const owner = personDefaults("bootstrap-owner", undefined, runId);
  const outsider = personDefaults("invited-outsider", { email: `invited-${runId}@outside.test` }, runId);
  const rejected = personDefaults("uninvited-outsider", { email: `uninvited-${runId}@outside.test` }, runId);
  const bootstrapCode = `test-bootstrap-${runId}`;
  const workspaceName = `Private workspace ${runId}`;
  const server = await selfHostServer({ place, name: workspaceName, slug: `private-${runId}`, ownerEmails: [owner.email], allowPublicSignup: false, bootstrapCode });
  try {
    const den = await seed.den({ reuse: server.ref, provision: false });
    const anonymous = den.admin;
    const verified = await seed.api(anonymous, "/v1/auth/bootstrap/verify", { method: "POST", body: JSON.stringify({ email: owner.email, code: bootstrapCode }), signal: AbortSignal.timeout(15_000) });
    const grant = verified.response.status === 200 ? record(verified.body).grant : undefined;
    const ownerSignUp = await seed.api(anonymous, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ ...owner, bootstrapGrant: grant }), signal: AbortSignal.timeout(15_000) });
    const bootstrap = { verifyStatus: verified.response.status, verifyText: verified.text, grant, signUpOk: ownerSignUp.response.ok, signUpText: ownerSignUp.text };
    const web = await seed.web({ den, headless: true });
    return { den, web, owner, outsider, rejected, bootstrapCode, bootstrap, workspaceName, anonymous, async [Symbol.asyncDispose]() { await server[Symbol.asyncDispose](); } };
  } catch (error) {
    await server[Symbol.asyncDispose]();
    throw error;
  }
}
