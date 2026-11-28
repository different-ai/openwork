import { denFetch, freshSession, type DenSession } from "@openwork/behaviors";
import { queryDenDatabase, type Seed } from "@openwork/env";
import { computerAuthorizeResponseSchema } from "@openwork/types/den/computers";
import { remoteDeviceResponseSchema } from "@openwork/types/den/remote-devices";
import { z } from "zod";
import { enableOrganizationCapabilities, seededOrganizationId } from "./organization-capabilities.ts";

export const computerNames = {
  mayaMac: "Maya's MacBook Pro", mayaWindows: "Maya's Windows PC", workbot: "Workbot's computer",
  tomasMac: "Tomás's MacBook Air", tomasLinux: "Tomás's Linux PC", buildBox: "Build box",
  priyaMac: "Priya's Mac mini", shared: "Northwind shared computer", instance: "Northwind OpenWork instance",
  jonasMac: "Jonas's MacBook Air", jonasWindows: "Jonas's Windows PC", olderLinux: "Northwind spare Linux PC", olderMac: "Northwind spare Mac",
};

const memberContext = z.object({ currentMember: z.object({ id: z.string() }) });
const desktopRoute = "/v1/remote-devices/this-computer";
const appVersion = "1.6.0";
const platformInfo = {
  darwin: { osVersion: "26.1", arch: "arm64" },
  win32: { osVersion: "Windows 11 24H2", arch: "x64" },
  linux: { osVersion: "Ubuntu 24.04", arch: "x64" },
};
const day = 24 * 60;

export async function computersInventoryWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const den = await seed.den({ web: true, org: {
      name: "Northwind Labs", admin: { name: "Platform operator", email: "operator@northwind.test" },
      members: {
        priya: { name: "Priya Nair", email: "priya@northwind.test" }, maya: { name: "Maya Okafor", email: "maya@northwind.test" },
        tomas: { name: "Tomás Rivera", email: "tomas@northwind.test" }, jonas: { name: "Jonas Weber", email: "jonas@northwind.test" },
      },
    } });
    if (!den.database) throw new Error("The inventory proof needs its disposable local database, never an attached Den");
    const database = den.database.url;
    const orgId = await seededOrganizationId(seed, den.admin);
    if (!orgId) throw new Error("The world has no organization");
    const request = (session: DenSession, path: string, method = "GET", body?: unknown) => denFetch(session, path, {
      method, headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    async function send(session: DenSession, path: string, method = "GET", body?: unknown) {
      const result = await request(session, path, method, body);
      if (!result.response.ok) throw new Error(`${method} ${path}: HTTP ${result.response.status} ${result.text.slice(0, 400)}`);
      return result.body;
    }
    const memberId = async (session: DenSession) => memberContext.parse(await send(session, "/v1/org")).currentMember.id;
    const { maya, tomas, jonas } = den.members;
    const operatorId = await memberId(den.admin);
    const priyaId = await memberId(den.members.priya);
    await send(den.admin, `/v1/members/${priyaId}/role`, "POST", { role: "admin" });
    await send(den.admin, `/v1/members/${priyaId}/transfer-ownership`, "POST");
    const priya = await freshSession(den.members.priya);
    den.admin = await freshSession(den.admin);
    stack.defer(async () => {
      const owner = await freshSession(priya);
      await send(owner, `/v1/members/${operatorId}/role`, "POST", { role: "admin" });
      await send(owner, `/v1/members/${operatorId}/transfer-ownership`, "POST");
      den.admin = await freshSession(den.admin);
    });

    const missingPermissions = {
      enabled: true, remoteEnabled: false, selectedId: "this-mac",
      computers: [{ id: "this-mac", label: "This Mac", placement: "local", readiness: "setup-required", detail: "Screen Recording is off" }],
      permissions: { accessibility: true, screenRecording: false },
    };
    async function desktop(session: DenSession, installId: string, label: string, platform: keyof typeof platformInfo, version = appVersion, missing = false) {
      return remoteDeviceResponseSchema.parse(await send(await freshSession(session), desktopRoute, "PUT", {
        installId, label, platform, appVersion: version, ...platformInfo[platform], ...(missing ? { computerUse: missingPermissions } : {}),
      })).device;
    }
    async function cloud(session: DenSession, label: string, externalId: string, shared: boolean) {
      return remoteDeviceResponseSchema.parse(await send(session, "/v1/remote-devices", "POST", {
        label, provider: "daytona", platform: "linux", externalId, shared,
      })).device;
    }
    const backdate = (id: string, addedMinutes: number, seenMinutes: number) => queryDenDatabase(database,
      "UPDATE remote_device SET created_at = TIMESTAMPADD(MINUTE, ?, UTC_TIMESTAMP(3)), last_seen_at = TIMESTAMPADD(MINUTE, ?, UTC_TIMESTAMP(3)) WHERE organization_id = ? AND id = ?",
      [-addedMinutes, -seenMinutes, orgId, id]);

    const mayaOldIds: string[] = [];
    for (const install of [
      { version: "1.5.2", added: 21 * day, seen: 17 * day },
      { version: "1.5.3", added: 15 * day + 3, seen: 11 * day + 3 },
      { version: "1.5.4", added: 11 * day, seen: 7 * day },
      { version: "1.5.5", added: 6 * day, seen: 2 * day },
    ]) {
      const signedIn = await desktop(maya, `northwind-maya-mac-${install.version}`, computerNames.mayaMac, "darwin", install.version);
      await backdate(signedIn.id, install.added, install.seen);
      mayaOldIds.push(signedIn.id);
    }
    const mayaInstallId = "northwind-maya-mac-current";
    const mayaMac = await desktop(maya, mayaInstallId, computerNames.mayaMac, "darwin");
    const mayaWindows = await desktop(maya, "northwind-maya-windows", computerNames.mayaWindows, "win32");
    const tomasMac = await desktop(tomas, "northwind-tomas-mac", computerNames.tomasMac, "darwin", appVersion, true);
    const tomasLinux = await desktop(tomas, "northwind-tomas-linux", computerNames.tomasLinux, "linux");
    await backdate(tomasLinux.id, 15 * day, 3 * day);
    const buildBox = await cloud(tomas, computerNames.buildBox, "northwind-build", false);
    const priyaMac = await desktop(priya, "northwind-priya-mac", computerNames.priyaMac, "darwin");
    const shared = await cloud(priya, computerNames.shared, "northwind-shared", true);
    const jonasMac = await desktop(jonas, "northwind-jonas-mac", computerNames.jonasMac, "darwin");
    const jonasWindows = await desktop(jonas, "northwind-jonas-windows", computerNames.jonasWindows, "win32");
    await backdate(jonasMac.id, 14 * day, day);
    await backdate(jonasWindows.id, 20 * day, 2 * day);
    const jonasId = await memberId(jonas);
    await send(priya, `/v1/members/${jonasId}`, "DELETE");
    const olderLinux = await desktop(tomas, "northwind-spare-linux", computerNames.olderLinux, "linux", "1.5.0");
    await backdate(olderLinux.id, 18 * day, 10 * day);
    const olderMac = await desktop(priya, "northwind-spare-mac", computerNames.olderMac, "darwin", "1.4.9");
    await backdate(olderMac.id, 60 * day, 39 * day);

    const { token } = z.object({ token: z.string() }).parse(await send(maya, "/v1/session-runners/token", "POST", {
      runnerId: mayaInstallId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion, platform: "darwin", concurrency: 1,
      capabilities: ["remote_session_v1", "remote_session_control_v1", "remote_session_access_v1"],
    }));
    await send({ ...maya, token }, "/v1/session-runners/inventory", "PUT", {
      computer: { label: computerNames.mayaMac, platform: "darwin", appVersion },
      workspaces: [{ workspaceId: "northwind-projects", name: "Northwind projects", active: true, engine: "v2", defaultModel: null, models: [] }],
    });

    const chats = [
      { person: maya, chat: "main", id: `rdv_${"1".repeat(26)}`, seen: 0 },
      { person: maya, chat: "project-notes", id: `rdv_${"2".repeat(26)}`, seen: 90 },
      { person: tomas, chat: "main", id: `rdv_${"3".repeat(26)}`, seen: 0 },
    ];
    for (const { person, chat, id, seen } of chats) {
      await queryDenDatabase(database, `INSERT INTO remote_device
        (id, organization_id, owner_member_id, kind, provider, source, platform, external_id, label, workbot_chat, state, created_at, last_seen_at)
        VALUES (?, ?, ?, 'vm', 'workbot', 'workbot', 'linux', ?, ?, ?, 'ready', TIMESTAMPADD(DAY, -2, UTC_TIMESTAMP(3)), TIMESTAMPADD(MINUTE, ?, UTC_TIMESTAMP(3)))`,
      [id, orgId, await memberId(person), `${person.email}:${chat}`, computerNames.workbot, chat, -seen]);
    }
    const instanceId = `wrk_${"1".repeat(26)}`;
    await queryDenDatabase(database, `INSERT INTO worker
      (id, org_id, created_by_user_id, name, destination, status, image_version, last_heartbeat_at, last_active_at)
      SELECT ?, ?, id, ?, 'local', 'healthy', ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3) FROM user WHERE email = ?`,
    [instanceId, orgId, computerNames.instance, appVersion, priya.email]);

    const viewport = { width: 1440, height: 1000, deviceScaleFactor: 1 };
    const mayaWeb = await seed.web({ den, signedInAs: maya, startPath: "/dashboard/my-computers", headless: true, viewport });
    const priyaWeb = await seed.web({ den, signedInAs: priya, startPath: "/dashboard/computers", headless: true, viewport });
    const tomasWeb = await seed.web({ den, signedInAs: tomas, startPath: "/dashboard/my-computers", headless: true, viewport });
    const priyaSummary = await seed.web({ den, signedInAs: priya, startPath: "/dashboard/computers", headless: true, viewport });
    return {
      maya: mayaWeb, priya: priyaWeb, tomas: tomasWeb, priyaSummary,
      devices: { mayaMac, mayaWindows, tomasMac, tomasLinux, buildBox, priyaMac, shared, jonasMac, jonasWindows, olderLinux, olderMac },
      mayaOldIds, instanceId,
      url: (path: string) => new URL(path, den.ref.webUrl).toString(),
      turnOnComputers: () => enableOrganizationCapabilities(seed, den.admin, { computers: true }, orgId),
      memberRequest: (path: string) => request(maya, path),
      async authorizeBuildBox() {
        const result = await request(tomas, `/v1/computers/${buildBox.id}/authorize`, "POST", {
          action: { type: "shell", command: "ls", cwd: "/workspace" },
        });
        return { status: result.response.status, result: computerAuthorizeResponseSchema.safeParse(result.body).data };
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}

export const supportedTargets = ["local/host"];
