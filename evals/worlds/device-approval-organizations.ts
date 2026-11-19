import { denFetch } from "@openwork/behaviors";
import type { Den, Seed } from "@openwork/env";
import { record, rows, text } from "./org-invite.ts";

async function deviceRequest(den: Den, clientId: string) {
  const started = await denFetch(den.ref, "/api/auth/device/code", {
    method: "POST", body: JSON.stringify({ client_id: clientId }), signal: AbortSignal.timeout(15_000),
  });
  if (!started.response.ok) throw new Error(`Start device approval: HTTP ${started.response.status}`);
  const request = record(started.body);
  const url = new URL("/device", den.ref.webUrl);
  url.searchParams.set("user_code", text(request.user_code));
  return {
    url: url.toString(),
    async redeem() {
      const result = await denFetch(den.ref, "/api/auth/device/token", {
        method: "POST", signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ client_id: clientId, device_code: text(request.device_code), grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      });
      // Device bearers never leave this closure or enter proof evidence.
      const token = record(result.body).access_token;
      let organizationId: string | null = null;
      if (typeof token === "string") {
        const directory = await denFetch(den.ref, "/v1/me/orgs", { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
        if (!directory.response.ok) throw new Error(`Read approved device organization: HTTP ${directory.response.status}`);
        const activeId = rows(record(directory.body).orgs).find((organization) => organization.isActive === true)?.id;
        organizationId = typeof activeId === "string" ? activeId : null;
      }
      return { status: result.response.status, error: record(result.body).error, sessionIssued: typeof token === "string", organizationId };
    },
  };
}

/** The actual Den approval page, without a desktop or synthetic component mount. */
export async function deviceApprovalOrganizations(seed: Seed) {
  const den = await seed.den({
    org: { name: "Organization A", admin: { name: "Organization Owner" }, members: { single: { name: "Organization Member" } } },
  });
  const member = den.members.single;
  if (!member) throw new Error("The single-organization member was not provisioned.");
  const first = await seed.api(den.admin, "/v1/org");
  if (!first.response.ok) throw new Error(`Read organization A: HTTP ${first.response.status}`);
  const orgA = record(record(first.body).organization);
  const second = await seed.api(den.admin, "/v1/org", { method: "POST", body: JSON.stringify({ name: "Organization B" }) });
  if (!second.response.ok) throw new Error(`Create organization B: HTTP ${second.response.status}`);
  const orgB = record(record(second.body).organization);
  const active = await seed.api(den.admin, "/v1/me/active-organization", { method: "POST", body: JSON.stringify({ organizationId: text(orgA.id) }) });
  if (!active.response.ok) throw new Error(`Activate organization A: HTTP ${active.response.status}`);
  const rollout = await seed.api(den.admin, "/v1/admin/features/remoteDesktopDeviceLogin", { method: "PUT", body: JSON.stringify({ enabled: true, killed: false }) });
  if (!rollout.response.ok) throw new Error(`Enable isolated device sign-in: HTTP ${rollout.response.status}`);
  const desktop = await deviceRequest(den, "openwork-desktop-device");
  const single = await deviceRequest(den, "openwork-desktop-device");
  const cli = await deviceRequest(den, "openwork-cli");
  const plugin = await deviceRequest(den, "openwork-opencode-plugin");
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/device", headless: true, viewport: { width: 1440, height: 1000 } });
  const singleWeb = await seed.web({ den, signedInAs: member, startPath: "/device", headless: true, viewport: { width: 1440, height: 1000 } });
  for (const surface of [web, singleWeb]) {
    await surface.client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  }
  return {
    web, singleWeb, desktop, single, cli, plugin,
    orgA: { id: text(orgA.id), name: text(orgA.name) }, orgB: { id: text(orgB.id), name: text(orgB.name) },
    async browserOrganizationId() {
      const result = await denFetch(den.admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${den.admin.token}` }, signal: AbortSignal.timeout(15_000) });
      if (!result.response.ok) throw new Error(`Read browser organization: HTTP ${result.response.status}`);
      return rows(record(result.body).orgs).find((organization) => organization.isActive === true)?.id ?? null;
    },
    async [Symbol.asyncDispose]() {
      const result = await denFetch(den.admin, "/v1/admin/features/remoteDesktopDeviceLogin", {
        method: "PUT", headers: { authorization: `Bearer ${den.admin.token}` }, body: JSON.stringify({ enabled: false, killed: false }), signal: AbortSignal.timeout(15_000),
      });
      if (!result.response.ok) throw new Error(`Restore isolated device sign-in rollout: HTTP ${result.response.status}`);
    },
  };
}
