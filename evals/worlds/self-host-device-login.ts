import { denFetch, signIn } from "@openwork/behaviors";
import { personDefaults, type Place, type Seed } from "@openwork/env";
import type { StartSelfHostServer } from "./self-host-install.ts";
import { localInviteNeeds, record, rows, text } from "./org-invite.ts";

/** Compatibility lane uses the same operator-installed server world as the install proof. */
export async function selfHostDeviceLogin(seed: Seed, context: { place: Place }, start: StartSelfHostServer) {
  await localInviteNeeds();
  const id = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const owner = personDefaults("device-owner", undefined, id);
  const bootstrapCode = `device-bootstrap-${id}`;
  const server = await start({
    place: context.place, name: "Private device workspace", slug: `device-${id}`, ownerEmails: [owner.email],
    bootstrapCode, allowPublicSignup: false, env: { DEN_FEATURE_REMOTE_DESKTOP_DEVICE_LOGIN: "true" },
  });
  try {
    // The install world publishes localhost as DEN_BASE_URL. Its browser proxy
    // deliberately rejects writes from the 127.0.0.1 alias (forbidden_origin),
    // so use that real canonical origin for both session seeding and approval.
    const den = await seed.den({ reuse: { ...server.ref, webUrl: server.ref.webUrl.replace("127.0.0.1", "localhost") }, provision: false });
    const verified = await seed.api(den.admin, "/v1/auth/bootstrap/verify", {
      method: "POST", body: JSON.stringify({ email: owner.email, code: bootstrapCode }),
    });
    if (!verified.response.ok) throw new Error(`Private server bootstrap: HTTP ${verified.response.status}`);
    const created = await seed.api(den.admin, "/api/auth/sign-up/email", {
      method: "POST", body: JSON.stringify({ ...owner, bootstrapGrant: text(record(verified.body).grant) }),
    });
    if (!created.response.ok) throw new Error(`Private server owner signup: HTTP ${created.response.status}`);
    const approver = await signIn(server.ref, owner);
    den.admin = approver;
    const directory = await seed.api(approver, "/v1/me/orgs");
    const [organization] = rows(record(directory.body).orgs);
    if (!organization) throw new Error("Private server did not bootstrap its organization.");
    const code = await denFetch(den.ref, "/api/auth/device/code", {
      method: "POST", body: JSON.stringify({ client_id: "openwork-desktop-device" }),
    });
    if (!code.response.ok) throw new Error(`Private server device start: HTTP ${code.response.status}`);
    const issued = record(code.body);
    const deviceCode = text(issued.device_code);
    const web = await seed.web({ den, signedInAs: approver, startPath: "/device", headless: true, viewport: { width: 1440, height: 1000 } });
    return {
      web, email: owner.email, organizationId: text(organization.id), organizationName: text(organization.name),
      verificationUrl: new URL(`/device?user_code=${encodeURIComponent(text(issued.user_code))}`, den.ref.webUrl).toString(), userCode: text(issued.user_code),
      async redeem() {
        const result = await denFetch(den.ref, "/api/auth/device/token", {
          method: "POST", body: JSON.stringify({ client_id: "openwork-desktop-device", device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
          signal: AbortSignal.timeout(15_000),
        });
        const body = record(result.body);
        if (!result.response.ok) return { status: result.response.status, error: body.error, freshSession: false, email: null, organizationId: null };
        const token = text(body.access_token);
        const me = await denFetch(den.ref, "/v1/me", { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
        const identity = record(me.body);
        // Tokens remain in this request witness, never in snapshots or assertions.
        return { status: result.response.status, error: null, freshSession: token !== approver.token, email: record(identity.user).email, organizationId: record(identity.session).activeOrganizationId };
      },
      async [Symbol.asyncDispose]() { await server[Symbol.asyncDispose](); },
    };
  } catch (error) {
    await server[Symbol.asyncDispose]();
    throw error;
  }
}
