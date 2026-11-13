import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denComputersWorld } from "../worlds/den-computers.ts";

const test = spec.world(denComputersWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an ordinary organization admin manages Computers in the Den team dashboard, without platform rights or cross-organization access", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.admin), adminProbe = probe.on(world.admin), member = user.on(world.member);
  await step("the fixture is a normal organization admin and owner, not a platform operator", async () => {
    expect(await world.roles()).toEqual({ admin: "admin", owner: "owner" });
    const platform = await world.adminRequest("/v1/admin/organizations");
    const ownerPlatform = await world.ownerRequest("/v1/admin/organizations");
    const ownerComputers = await world.ownerRequest("/v1/org/computers");
    expect(platform.response.status).toBe(403);
    expect(ownerPlatform.response.status).toBe(403);
    expect(ownerComputers.response.status).toBe(200);
    evidence.recordAssertionEvidence("Organization roles do not grant platform rights", `org admin platform API=${platform.response.status}; owner platform API=${ownerPlatform.response.status}; owner team Computers=${ownerComputers.response.status}`, platform.response.status === 403 && ownerPlatform.response.status === 403 && ownerComputers.response.status === 200);
  });
  await step("from the normal Den team dashboard, click Manage › Computers", async () => {
    await admin.see({ text: "Manage" }, { timeoutMs: 60_000 });
    await admin.click({ testId: "dashboard-nav-computers" });
    await admin.see({ role: "heading", label: "Computers" }, { timeoutMs: 60_000 });
    for (const label of ["Alex's MacBook Pro", "Riley's Windows laptop", "Casey's Freestyle VM", "Alex's Daytona VM", "Studio shared Mac"]) await admin.see({ text: label });
    for (const text of ["Alex Morgan", "Riley Chen", "Casey Rivera", "Online", "Needs setup", "Not checked yet", "Last contact", "App version", "1.5.2", "1.4.9"]) await admin.see({ text });
    await admin.see({ testId: "registered-instances" });
    await admin.see({ text: "Studio local OpenWork" });
    await admin.see({ text: "openwork-proof-1.5.2" });
    await admin.notSee({ text: "FOREIGN OpenWork instance" });
    await admin.notSee({ text: "FOREIGN confidential Mac" });
    const rows = await adminProbe.dom('[data-testid^="computer-row-"]');
    expect(rows.elements).toHaveLength(5);
    expect(new URL(await adminProbe.url()).pathname).toBe("/dashboard/computers");
    const header = await adminProbe.dom("header");
    expect(header.elements.some(element => element.text.includes("Computers"))).toBe(true);
    const list = await world.list();
    expect(list.total).toBe(5);
    expect(list.instancesTotal).toBe(1);
    expect(list.instances).toEqual([expect.objectContaining({ id: world.instanceId, name: "Studio local OpenWork", version: "openwork-proof-1.5.2", destination: "local" })]);
    expect(list.devices.every(device => device.organization.id === world.organizationId)).toBe(true);
    const mac = list.devices.find(device => device.id === world.devices.mac.id), windows = list.devices.find(device => device.id === world.devices.windows.id);
    expect(mac).toMatchObject({ appVersion: "1.5.2", availability: "online" });
    expect(windows).toMatchObject({ appVersion: "1.4.9", availability: "needs_setup" });
    expect(mac?.lastSeenAt).toBeTruthy();
    expect(windows?.lastSeenAt).toBeTruthy();
    evidence.recordAssertionEvidence("Team inventory, in the regular Den shell", `path=/dashboard/computers; ${list.total} computers; different owners, Mac/Windows app versions, last contact, readiness, Freestyle/Daytona/shared Mac; registered local OpenWork version visible; foreign rows absent`, list.total === 5 && list.instancesTotal === 1 && list.instances[0]?.id === world.instanceId && rows.elements.length === 5);
    await admin.screenshot();
  });
  await step("expanding a laptop shows supported computer-use and runner inventory", async () => {
    await admin.click({ testId: `computer-row-${world.devices.mac.id}` });
    await admin.see({ testId: `computer-detail-${world.devices.mac.id}` });
    for (const text of ["Computer use", "Operating system", "25.1.0 arm64", "Screen Recording", "This Mac", "Ready", "Runner", "Workspaces", "remote_session_v1"]) await admin.see({ text });
    const detail = await world.detail(world.devices.mac.id);
    expect(detail.diagnostics?.computerUse?.permissions).toEqual({ accessibility: true, screenRecording: true });
    expect(detail.runner?.workspaces).toBe(1);
    expect(detail.runner?.capabilities).toContain("remote_session_v1");
    expect(detail.events.length).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("Expanded computer is the real registration and inventory", `app=1.5.2; macOS=${detail.diagnostics?.osVersion}; runner workspaces=${detail.runner?.workspaces}; events=${detail.events.length}`, detail.runner?.workspaces === 1 && detail.events.length > 0 && detail.diagnostics?.computerUse?.permissions?.screenRecording === true);
    await admin.screenshot();
  });
  await step("search and filters stay in the active organization", async () => {
    const search = await world.list("?search=Riley&kind=desktop&provider=openwork_desktop&availability=needs_setup&page=1");
    expect(search.total).toBe(1);
    expect(search.devices[0]?.id).toBe(world.devices.windows.id);
    const foreign = await world.adminRequest(`/v1/org/computers/${world.devices.foreign.id}`);
    const bypassDetail = await world.adminRequest(`/v1/org/computers/${world.devices.foreign.id}?organizationId=${world.foreignOrg}`);
    const bypassList = await world.list(`?organizationId=${world.foreignOrg}`);
    expect(foreign.response.status).toBe(404);
    expect(bypassDetail.response.status).toBe(404);
    expect(bypassList.instances.some(instance => instance.id === world.foreignInstanceId)).toBe(false);
    const foreignInstance = await world.adminRequest(`/v1/org/computers/instances/${world.foreignInstanceId}`);
    expect(foreignInstance.response.status).toBe(404);
    expect(bypassList.devices.some(device => device.id === world.devices.foreign.id)).toBe(false);
    expect(bypassList.devices.every(device => device.organization.id === world.organizationId)).toBe(true);
    evidence.recordAssertionEvidence("An organization parameter cannot escape membership scope", `filtered Riley rows=${search.total}; foreign detail=${foreign.response.status}; foreign detail with organizationId=${bypassDetail.response.status}; foreign list rows=0; foreign instance detail=${foreignInstance.response.status}`, search.total === 1 && foreign.response.status === 404 && bypassDetail.response.status === 404 && foreignInstance.response.status === 404 && bypassList.devices.every(device => device.organization.id === world.organizationId) && !bypassList.instances.some(instance => instance.id === world.foreignInstanceId));
  });
  await step("an ordinary member opens Work › My Computers and sees only their own laptop and the shared Mac", async () => {
    const memberProbe = probe.on(world.member);
    await member.see({ text: "Fieldnotes Studio" }, { timeoutMs: 60_000 });
    await member.click({ testId: "dashboard-nav-my-computers" });
    await member.see({ role: "heading", label: "My Computers" }, { timeoutMs: 60_000 });
    for (const text of ["Riley's Windows laptop", "Windows PC", "Needs setup", "1.4.9", "Studio shared Mac", "Shared with your organization", "Not checked yet"]) await member.see({ text });
    for (const text of ["Alex's MacBook Pro", "Alex's Daytona VM", "Casey's Freestyle VM", "Studio local OpenWork"]) await member.notSee({ text });
    const rows = await memberProbe.dom('[data-testid^="my-computer-row-"]');
    const path = new URL(await memberProbe.url()).pathname;
    await member.click({ testId: `my-computer-row-${world.devices.windows.id}` });
    await member.see({ text: "Needs setup: Computer use needs setup" }, { timeoutMs: 30_000 });
    await member.see({ text: "Signed in on OpenWork 1.4.9" });
    const ok = rows.elements.length === 2 && path === "/dashboard/my-computers";
    evidence.recordAssertionEvidence("Members view their own computers in Den, and nobody else's", `path=${path}; rows=${rows.elements.length} (own Windows laptop, shared Mac); other members' computers and team instances absent; recent activity opens in place`, ok);
    expect(ok).toBe(true);
    await member.screenshot();
  });
  await step("ordinary members have no team-management entry and retain only their own and shared personal computers", async () => {
    await member.see({ text: "Fieldnotes Studio" }, { timeoutMs: 60_000 });
    await member.notSee({ testId: "dashboard-nav-computers" });
    const list = await world.memberRequest("/v1/org/computers");
    const detail = await world.memberRequest(`/v1/org/computers/${world.devices.mac.id}`);
    expect(list.response.status).toBe(403);
    expect(detail.response.status).toBe(403);
    const personal = await world.personal();
    expect(personal.map(device => device.id).sort()).toEqual([world.devices.windows.id, world.devices.shared.id].sort());
    await member.navigate(world.url("/dashboard/computers"));
    await probe.eventually(async () => new URL(await probe.on(world.member).url()).pathname, { within: 30_000, until: path => path === "/dashboard", label: "member management URL returns to the team home" });
    await member.notSee({ text: "Alex's MacBook Pro" });
    evidence.recordAssertionEvidence("No admin list for members; personal scope is unchanged", `org list=${list.response.status}; org detail=${detail.response.status}; personal list=${personal.map(device => device.label).join(", ")}; direct management URL redirects to team home`, list.response.status === 403 && detail.response.status === 403 && personal.length === 2 && personal.every(device => [world.devices.windows.id, world.devices.shared.id].includes(device.id)));
    await member.screenshot();
  });

});
