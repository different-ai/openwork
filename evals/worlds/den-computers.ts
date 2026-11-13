import { queryDenDatabase, type Seed } from "@openwork/env";
import type { DenSession } from "@openwork/behaviors";
import { denFetch, freshSession } from "@openwork/behaviors";
import { z } from "zod";
import { organizationComputerListResponseSchema, organizationComputerDetailResponseSchema, remoteDeviceListResponseSchema, remoteDeviceResponseSchema } from "@openwork/types/den/remote-devices";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

const contextSchema = z.object({ organization: z.object({ id: z.string() }), currentMember: z.object({ id: z.string(), role: z.string() }) });

/** Ordinary Den organization management, never the platform /admin surface.
 * Device registrations, role changes and runner inventory use the product API.
 * Stored worker registrations alone use seed-only inserts in the disposable DB.
 * The platform owner is used only to arrange the rollout and membership fixture.
 */
export async function denComputersWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const den = await seed.den({ web: true, org: {
      name: "Fieldnotes Studio", admin: { name: "Fixture Platform Operator" },
      members: { manager: { name: "Alex Morgan" }, owner: { name: "Casey Rivera" }, member: { name: "Riley Chen" }, foreign: { name: "Foreign Owner" } },
    } });
    if (!den.database) throw new Error("Computers proof requires a disposable local database, never an attached Den");
    const organizationId = await enableOrganizationCapabilities(seed, den.admin, { remoteDevices: true, remoteComputers: true });
    const request = (session: DenSession, path: string, body?: unknown, method = body === undefined ? "GET" : "POST", org = organizationId) =>
      denFetch(session, path, { method, headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": org }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const send = async (session: DenSession, path: string, body?: unknown, method?: string, org?: string) => {
      const result = await request(session, path, body, method, org);
      if (!result.response.ok) throw new Error(`${method ?? (body === undefined ? "GET" : "POST")} ${path}: HTTP ${result.response.status} ${result.text.slice(0, 400)}`);
      return result.body;
    };
    const fixtureId = contextSchema.parse(await send(den.admin, "/v1/org")).currentMember.id;
    const adminId = contextSchema.parse(await send(den.members.manager, "/v1/org")).currentMember.id;
    const ownerId = contextSchema.parse(await send(den.members.owner, "/v1/org")).currentMember.id;
    // Seed PersonShape does not expose a role option; use the same role endpoint as Members.
    await send(den.admin, `/v1/members/${adminId}/role`, { role: "admin" });
    await send(den.admin, `/v1/members/${ownerId}/role`, { role: "admin" });
    await send(den.admin, `/v1/members/${ownerId}/transfer-ownership`, undefined, "POST");
    den.members.manager = await freshSession(den.members.manager);
    den.members.owner = await freshSession(den.members.owner);
    den.admin = await freshSession(den.admin);
    stack.defer(async () => {
      const owner = await freshSession(den.members.owner);
      await send(owner, `/v1/members/${fixtureId}/role`, { role: "admin" });
      await send(owner, `/v1/members/${fixtureId}/transfer-ownership`, undefined, "POST");
      den.admin = await freshSession(den.admin);
    });
    const adminSession = den.members.manager, ownerSession = den.members.owner, memberSession = den.members.member;
    const mac = remoteDeviceResponseSchema.parse(await send(adminSession, "/v1/remote-devices/this-computer", {
      installId: "den-computers-alex-mac", label: "Alex's MacBook Pro", platform: "darwin", appVersion: "1.5.2", osVersion: "25.1.0", arch: "arm64",
      computerUse: { enabled: true, remoteEnabled: true, selectedId: "this-mac", computers: [{ id: "this-mac", label: "This Mac", placement: "local", readiness: "ready", detail: null }], permissions: { accessibility: true, screenRecording: true } },
    }, "PUT")).device;
    const windows = remoteDeviceResponseSchema.parse(await send(memberSession, "/v1/remote-devices/this-computer", {
      installId: "den-computers-riley-windows", label: "Riley's Windows laptop", platform: "win32", appVersion: "1.4.9", osVersion: "11 24H2", arch: "x64",
      computerUse: { enabled: true, remoteEnabled: false, selectedId: "this-pc", computers: [{ id: "this-pc", label: "This PC", placement: "local", readiness: "setup-required", detail: "Computer use needs setup" }], permissions: null },
    }, "PUT")).device;
    const register = async (session: DenSession, label: string, provider: "freestyle" | "daytona" | "mac_host", shared = false, org = organizationId) =>
      remoteDeviceResponseSchema.parse(await send(session, "/v1/remote-devices", { label, provider, platform: provider === "mac_host" ? "darwin" : "linux", externalId: `proof:${provider}:${shared ? "shared" : "private"}`, shared }, "POST", org)).device;
    const freestyle = await register(ownerSession, "Casey's Freestyle VM", "freestyle");
    const daytona = await register(adminSession, "Alex's Daytona VM", "daytona");
    const shared = await register(ownerSession, "Studio shared Mac", "mac_host", true);
    const minted = z.object({ token: z.string() }).parse(await send(adminSession, "/v1/session-runners/token", {
      runnerId: "den-computers-alex-mac", protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: "1.5.2", platform: "darwin", concurrency: 1,
      capabilities: ["remote_session_v1", "remote_session_control_v1"],
    }));
    await send({ ...adminSession, token: minted.token }, "/v1/session-runners/inventory", {
      computer: { label: "Alex's MacBook Pro", platform: "darwin", appVersion: "1.5.2" },
      workspaces: [{ workspaceId: "workspace-fieldnotes", name: "Fieldnotes", active: true, engine: "v2", defaultModel: null, models: [] }],
    }, "PUT");
    const foreignOrg = z.object({ organization: z.object({ id: z.string() }) }).parse(await send(den.members.foreign, "/v1/org", { name: "Foreign Organization" })).organization.id;
    await enableOrganizationCapabilities(seed, den.admin, { remoteDevices: true }, foreignOrg);
    const foreign = await register(den.members.foreign, "FOREIGN confidential Mac", "mac_host", false, foreignOrg);
    // Seed-only registration records in this world's disposable DB: never provision a paid host.
    // The product has no local-worker registration POST; all inventory reads remain real API/UI.
    const instanceId = `wrk_${"1".repeat(26)}`, foreignInstanceId = `wrk_${"2".repeat(26)}`;
    for (const [id, org, name, email] of [[instanceId, organizationId, "Studio local OpenWork", adminSession.email], [foreignInstanceId, foreignOrg, "FOREIGN OpenWork instance", den.members.foreign.email]]) {
      await queryDenDatabase(den.database.url, "INSERT INTO worker (id, org_id, created_by_user_id, name, destination, status, image_version, last_heartbeat_at, last_active_at) SELECT ?, ?, id, ?, 'local', 'healthy', 'openwork-proof-1.5.2', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3) FROM user WHERE email = ?", [id, org, name, email]);
    }
    const viewport = { width: 1440, height: 1000, deviceScaleFactor: 1 };
    const admin = await seed.web({ den, signedInAs: adminSession, startPath: "/dashboard", headless: true, viewport });
    const member = await seed.web({ den, signedInAs: memberSession, startPath: "/dashboard", headless: true, viewport });
    return {
      admin, member, organizationId, foreignOrg, instanceId, foreignInstanceId, devices: { mac, windows, freestyle, daytona, shared, foreign },
      url: (path: string) => new URL(path, den.ref.webUrl).toString(),
      adminRequest: (path: string) => request(adminSession, path),
      ownerRequest: (path: string) => request(ownerSession, path),
      memberRequest: (path: string) => request(memberSession, path),
      async list(query = "") { return organizationComputerListResponseSchema.parse(await send(adminSession, `/v1/org/computers${query}`)); },
      async detail(id: string) { return organizationComputerDetailResponseSchema.parse(await send(adminSession, `/v1/org/computers/${id}`)); },
      async personal() { return remoteDeviceListResponseSchema.parse(await send(memberSession, "/v1/remote-devices")).devices; },
      async roles() { return { admin: contextSchema.parse(await send(adminSession, "/v1/org")).currentMember.role, owner: contextSchema.parse(await send(ownerSession, "/v1/org")).currentMember.role }; },
      async setEnabled(enabled: boolean) { await send(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, { capabilities: { remoteDevices: enabled } }, "PUT"); },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
