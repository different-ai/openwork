import { queryDenDatabase, type Seed } from "@openwork/env";
import type { DenSession } from "@openwork/behaviors";
import { denFetch, freshSession } from "@openwork/behaviors";
import { z } from "zod";
import { organizationComputerListResponseSchema, remoteDeviceListResponseSchema, remoteDeviceResponseSchema, remoteDeviceDetailResponseSchema } from "@openwork/types/den/remote-devices";
import { memberSessionListResponseSchema } from "@openwork/types/den/remote-sessions";
import { seededOrganizationId } from "./organization-capabilities.ts";

/**
 * Disconnecting a signed-in computer, in regular Den. Den, its web app, the
 * device registry, runner tokens and sign-in sessions are real. Each desktop
 * is stood in for by its own sign-in of its owner (as OpenWork Desktop holds
 * one) that reports itself and registers as a runner through the same routes
 * the app uses. One seed-only write backdates an old install's last contact,
 * since nothing in the product can make 45 days pass.
 */

const contextSchema = z.object({ organization: z.object({ id: z.string() }), currentMember: z.object({ id: z.string(), role: z.string() }) });
const errorSchema = z.object({ error: z.string() });

type Desktop = { session: DenSession; runnerToken: string; installId: string; label: string; appVersion: string; deviceId: string };

export async function denComputerDisconnectWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const den = await seed.den({ web: true, org: {
      name: "Fieldnotes Studio", admin: { name: "Fixture Platform Operator" },
      members: { owner: { name: "Casey Rivera" }, manager: { name: "Alex Morgan" }, member: { name: "Riley Chen" }, leaver: { name: "Jordan Lee" } },
    } });
    if (!den.database) throw new Error("The disconnect proof requires a disposable local database, never an attached Den");
    const database = den.database.url;
    const organizationId = await seededOrganizationId(seed, den.admin);
    const request = (session: DenSession, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
      denFetch(session, path, { method, headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": organizationId }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const send = async (session: DenSession, path: string, body?: unknown, method?: string) => {
      const result = await request(session, path, body, method);
      if (!result.response.ok) throw new Error(`${method ?? (body === undefined ? "GET" : "POST")} ${path}: HTTP ${result.response.status} ${result.text.slice(0, 400)}`);
      return result.body;
    };
    // The seeded operator hands the organization to an ordinary owner; the manager becomes an ordinary admin.
    const fixtureId = contextSchema.parse(await send(den.admin, "/v1/org")).currentMember.id;
    const ownerId = contextSchema.parse(await send(den.members.owner, "/v1/org")).currentMember.id;
    const managerId = contextSchema.parse(await send(den.members.manager, "/v1/org")).currentMember.id;
    const leaverId = contextSchema.parse(await send(den.members.leaver, "/v1/org")).currentMember.id;
    await send(den.admin, `/v1/members/${managerId}/role`, { role: "admin" });
    await send(den.admin, `/v1/members/${ownerId}/role`, { role: "admin" });
    await send(den.admin, `/v1/members/${ownerId}/transfer-ownership`, undefined, "POST");
    den.members.owner = await freshSession(den.members.owner);
    den.members.manager = await freshSession(den.members.manager);
    den.admin = await freshSession(den.admin);
    stack.defer(async () => {
      const owner = await freshSession(den.members.owner);
      await send(owner, `/v1/members/${fixtureId}/role`, { role: "admin" });
      await send(owner, `/v1/members/${fixtureId}/transfer-ownership`, undefined, "POST");
      den.admin = await freshSession(den.admin);
    });
    const ownerSession = den.members.owner, managerSession = den.members.manager, memberSession = den.members.member;

    /** What OpenWork Desktop does after sign-in: report this computer, then register as its runner. */
    const report = async (session: DenSession, installId: string, label: string, appVersion: string) =>
      remoteDeviceResponseSchema.parse(await send(session, "/v1/remote-devices/this-computer", {
        installId, label, platform: "darwin", appVersion, osVersion: "25.1.0", arch: "arm64",
      }, "PUT")).device;
    const mint = (session: DenSession, installId: string, appVersion: string) => request(session, "/v1/session-runners/token", {
      runnerId: installId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion, platform: "darwin", concurrency: 1,
      capabilities: ["remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_answer_v1", "remote_session_access_v1"],
    });
    const signInOn = async (person: DenSession, installId: string, label: string, appVersion = "1.6.0"): Promise<Desktop> => {
      const session = await freshSession(person);
      const device = await report(session, installId, label, appVersion);
      const minted = await mint(session, installId, appVersion);
      if (!minted.response.ok) throw new Error(`Runner registration for ${label} failed: HTTP ${minted.response.status} ${minted.text.slice(0, 300)}`);
      const runnerToken = z.object({ token: z.string() }).parse(minted.body).token;
      const inventory = await denFetch(session, "/v1/session-runners/inventory", { method: "PUT", headers: { authorization: `Bearer ${runnerToken}` }, body: JSON.stringify({
        computer: { label, platform: "darwin", appVersion },
        workspaces: [{ workspaceId: "fieldnotes", name: "Fieldnotes", active: true, engine: "v2", defaultModel: null, models: [] }],
      }) });
      if (!inventory.response.ok) throw new Error(`Inventory for ${label} failed: HTTP ${inventory.response.status}`);
      return { session, runnerToken, installId, label, appVersion, deviceId: device.id };
    };
    const runnerCall = (desktop: Desktop, path: string) => denFetch(desktop.session, path, { method: "GET", headers: { authorization: `Bearer ${desktop.runnerToken}` } });

    const rileyMac = await signInOn(memberSession, "disconnect-riley-macbook", "Riley's MacBook Pro", "0.18.66-alpha.4137+053df1c");
    const rileyMini = await signInOn(memberSession, "disconnect-riley-macmini", "Riley's Mac mini");
    const alexMac = await signInOn(managerSession, "disconnect-alex-macbook", "Alex's MacBook Pro");
    // An install Riley replaced weeks ago, with the same name as the new one.
    const oldInstall = await report(await freshSession(memberSession), "disconnect-riley-macbook-old", "Riley's MacBook Pro", "0.17.2");
    await queryDenDatabase(database, "UPDATE remote_device SET last_seen_at = UTC_TIMESTAMP(3) - INTERVAL 45 DAY, created_at = UTC_TIMESTAMP(3) - INTERVAL 90 DAY WHERE id = ?", [oldInstall.id]);
    // Someone who has since left the organization.
    const jordanMac = await report(await freshSession(den.members.leaver), "disconnect-jordan-macbook", "Jordan's MacBook Air", "1.5.9");
    await send(await freshSession(ownerSession), `/v1/members/${leaverId}`, undefined, "DELETE");

    const viewport = { width: 1440, height: 1000, deviceScaleFactor: 1 };
    const admin = await seed.web({ den, signedInAs: managerSession, startPath: "/dashboard", headless: true, viewport });
    const member = await seed.web({ den, signedInAs: memberSession, startPath: "/dashboard", headless: true, viewport });
    return {
      admin, member, organizationId,
      desktops: { rileyMac, rileyMini, alexMac },
      devices: { oldInstall, jordanMac },
      leaverEmail: den.members.leaver.email,
      url: (path: string) => new URL(path, den.ref.webUrl).toString(),
      adminRequest: (path: string, body?: unknown, method?: string) => request(managerSession, path, body, method),
      memberRequest: (path: string, body?: unknown, method?: string) => request(memberSession, path, body, method),
      errorOf: (body: unknown) => errorSchema.safeParse(body).data?.error ?? "",
      async roles() {
        const role = async (session: DenSession) => contextSchema.parse(await send(session, "/v1/org")).currentMember.role;
        return { owner: await role(ownerSession), manager: await role(managerSession), member: await role(memberSession) };
      },
      async list(query = "") { return organizationComputerListResponseSchema.parse(await send(managerSession, `/v1/org/computers${query}`)); },
      async mine() { return remoteDeviceListResponseSchema.parse(await send(memberSession, "/v1/remote-devices")).devices; },
      async activity(deviceId: string) { return remoteDeviceDetailResponseSchema.parse(await send(memberSession, `/v1/remote-devices/${deviceId}`)).events; },
      async sessionComputers() { return memberSessionListResponseSchema.parse(await send(memberSession, "/v1/sessions")).computers.map((computer) => computer.label); },
      /** What the app on that computer now gets: its runner's work poll, its own sign-in, a new runner token, its report. */
      async probe(desktop: Desktop) {
        const [work, me, token, reported] = await Promise.all([
          runnerCall(desktop, "/v1/session-runners/work"),
          request(desktop.session, "/v1/me"),
          mint(desktop.session, desktop.installId, desktop.appVersion),
          request(desktop.session, "/v1/remote-devices/this-computer", { installId: desktop.installId, label: desktop.label, platform: "darwin", appVersion: desktop.appVersion, osVersion: "25.1.0", arch: "arm64" }, "PUT"),
        ]);
        const code = (result: { response: Response; body: unknown }) => `${result.response.status}${errorSchema.safeParse(result.body).success ? ` ${errorSchema.parse(result.body).error}` : ""}`;
        return { work: code(work), signIn: code(me), token: code(token), report: code(reported) };
      },
      /** Someone signs in to OpenWork on that computer again. */
      signInAgain: (desktop: Desktop, person: "member" | "manager") => signInOn(person === "member" ? memberSession : managerSession, desktop.installId, desktop.label, desktop.appVersion),
      async setFeature(key: "denGreySidebar", enabled: boolean) {
        await send(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, { capabilities: { [key]: enabled } }, "PUT");
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
export const supportedTargets = ["local/host"];
