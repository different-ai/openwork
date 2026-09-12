import { denFetch, signIn, type DenSession } from "@openwork/behaviors";
import { createAdmin, localMysqlIsRunning, localRedisIsRunning, needs, personDefaults, queryDenDatabase, SkipError, type Seed } from "@openwork/env";

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

export function emailLinks(html: string): string[] {
  return [...html.matchAll(/href=["'](https?:\/\/[^"']+)["']/g)].map((match) => match[1].replaceAll("&amp;", "&"));
}

export function membersFor(org: Record<string, unknown>, email: string) {
  return rows(org.members).filter((member) => member.userId && member.joinedAt && member.user && record(member.user).email === email);
}

export function invitationsFor(org: Record<string, unknown>, email: string) {
  return rows(org.invitations).filter((invitation) => invitation.email === email);
}

export async function orgInvite(seed: Seed) {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const identity = (key: string) => personDefaults(key, undefined, runId);
  const den = await seed.den({
    org: { name: `Invite workspace ${runId}`, admin: identity("invite-owner"), members: {} },
    env: {
      DEN_ORG_MODE: "multi_org", DEN_REQUIRE_EMAIL_VERIFICATION: "true",
      DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "true", OPENWORK_DEV_MODE: "1",
      RESEND_API_KEY: "", SMTP_HOST: "", GOOGLE_CLIENT_ID: "invite-google-client", GOOGLE_CLIENT_SECRET: "invite-google-secret",
    },
  });
  const owner = den.admin;
  const witnesses = invitationWitnesses(owner);
  const organization = record((await witnesses.org()).organization);
  const other = await createAdmin(den, identity("other-owner"));
  try {
    const created = await seed.api(other, "/v1/org", { method: "POST", body: JSON.stringify({ name: `Other workspace ${runId}` }) });
    if (!created.response.ok) throw new Error(`Second organization: HTTP ${created.response.status}`);
    const otherOrg = record(record(created.body).organization);
    const web = await seed.web({ den, startPath: "/", headless: true });
    return {
      den, web, owner, other, organization, otherOrg, identity, witnesses,
      fresh: (startPath = "/", signedInAs?: DenSession) => seed.web({ den, startPath, signedInAs, headless: true }),
      async sessionsFor(email: string) {
        if (!den.database) throw new Error("Session witness requires the isolated Den database");
        return queryDenDatabase(den.database.url, "SELECT session.id FROM session INNER JOIN user ON user.id = session.user_id WHERE user.email = ? AND session.expires_at > NOW()", [email]);
      },
    };
  } finally {
    den.admin = owner;
  }
}
