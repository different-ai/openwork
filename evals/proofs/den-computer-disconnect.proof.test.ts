import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denComputerDisconnectWorld } from "../worlds/den-computer-disconnect.ts";

const test = spec.world(denComputerDisconnectWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an admin and a computer's owner each disconnect a signed-in computer from Den, and only a new sign-in on it reconnects it", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.admin), member = user.on(world.member), adminProbe = probe.on(world.admin), memberProbe = probe.on(world.member);
  const { rileyMac, rileyMini, alexMac } = world.desktops;
  const row = async (deviceId: string) => (await world.list("?stale=include")).devices.find((device) => device.id === deviceId);

  await step("the team list is short and honest: old installs folded away, a leaver named as one, versions readable", async () => {
    expect(await world.roles()).toEqual({ owner: "owner", manager: "admin", member: "member" });
    await admin.see({ text: "Manage" }, { timeoutMs: 60_000 });
    await admin.click({ testId: "dashboard-nav-computers" });
    await admin.see({ role: "heading", label: "Computers" }, { timeoutMs: 60_000 });
    for (const text of ["Riley's MacBook Pro", "Riley's Mac mini", "Alex's MacBook Pro", "Jordan's MacBook Air", "Former member", "0.18.66 alpha", "Remote access", "What other devices can do on computers"]) await admin.see({ text });
    await admin.see({ testId: "computers-stale" });
    const body = await adminProbe.text();
    const list = await world.list();
    expect(body).not.toContain("4137+053df1c");
    expect(body).not.toContain(world.leaverEmail);
    expect(list.total).toBe(4);
    expect(list.staleHidden).toBe(1);
    expect(list.devices.find((device) => device.id === world.devices.jordanMac.id)).toMatchObject({ owner: { former: true }, canDisconnect: false, canRemove: true });
    expect(list.devices.find((device) => device.id === rileyMac.deviceId)).toMatchObject({ canDisconnect: true, canRemove: false, disconnectedAt: null });
    expect((await adminProbe.dom('[data-testid^="computer-row-"]')).elements).toHaveLength(4);
    evidence.recordAssertionEvidence("A readable team list", `listed=${list.total}, online=${list.online}, older installs folded away=${list.staleHidden}; a leaver's computer reads "Former member"; the long build version is shortened; no email shown as an owner`, list.total === 4 && list.staleHidden === 1);
    await admin.screenshot();
    await admin.click({ testId: "computers-show-stale" });
    await probe.eventually(async () => (await adminProbe.dom('[data-testid^="computer-row-"]')).elements.length, { within: 30_000, until: (count) => count === 5, label: "the old install is listed when asked" });
    await admin.see({ text: /Added \d/ });
    await admin.click({ testId: "computers-hide-stale" });
    await probe.eventually(async () => (await adminProbe.dom('[data-testid^="computer-row-"]')).elements.length, { within: 30_000, until: (count) => count === 4, label: "the old install is folded away again" });
  });

  await step("an admin disconnects a member's computer: Den refuses it at once and signs OpenWork out there", async () => {
    const before = await world.probe(rileyMac);
    expect(before).toEqual({ work: "200", signIn: "200", token: "200", report: "200" });
    await admin.click({ testId: `computer-menu-${rileyMac.deviceId}` });
    await admin.click({ testId: `computer-disconnect-${rileyMac.deviceId}` });
    await admin.see({ testId: "confirm-dialog" }, { timeoutMs: 30_000 });
    await admin.see({ text: "Disconnect Riley's MacBook Pro?" });
    await admin.screenshot();
    await admin.click({ testId: "confirm-dialog-action" });
    await admin.see({ text: "Disconnected. OpenWork was signed out on that computer." }, { timeoutMs: 30_000 });
    await admin.see({ text: "Disconnected" });
    const after = await world.probe(rileyMac);
    const record = await row(rileyMac.deviceId);
    expect(after).toEqual({ work: "403 computer_disconnected", signIn: "401 unauthorized", token: "401 unauthorized", report: "401 unauthorized" });
    expect(record).toMatchObject({ availability: "offline", canDisconnect: false, canRemove: true });
    expect(record?.disconnectedAt).toBeTruthy();
    expect(await world.sessionComputers()).toEqual(["Riley's Mac mini"]);
    expect((await world.probe(rileyMini)).work).toBe("200");
    expect((await world.memberRequest("/v1/me")).response.status).toBe(200);
    evidence.recordAssertionEvidence("Disconnected means refused everywhere", `before: ${JSON.stringify(before)}; after: ${JSON.stringify(after)}; Riley's other computer and Riley's browser are untouched; the computer no longer appears among Riley's session computers`, after.work === "403 computer_disconnected" && after.signIn === "401 unauthorized");
    await admin.screenshot();
  });

  await step("the member sees it disconnected and what to do, and disconnects another of their own computers", async () => {
    await member.see({ text: "Fieldnotes Studio" }, { timeoutMs: 60_000 });
    await member.click({ testId: "dashboard-nav-my-computers" });
    await member.see({ role: "heading", label: "My Computers" }, { timeoutMs: 60_000 });
    await member.see({ text: "Riley's Mac mini" });
    await member.see({ text: "Disconnected" });
    await member.notSee({ text: "Alex's MacBook Pro" });
    const events = await world.activity(rileyMac.deviceId);
    expect(events[0]).toMatchObject({ type: "disconnected", message: "Disconnected by an admin" });
    await member.click({ testId: `my-computer-menu-${rileyMini.deviceId}` });
    await member.click({ testId: `my-computer-disconnect-${rileyMini.deviceId}` });
    await member.see({ text: "Disconnect Riley's Mac mini?" }, { timeoutMs: 30_000 });
    await member.click({ testId: "confirm-dialog-action" });
    await member.see({ text: "Disconnected. OpenWork was signed out on that computer." }, { timeoutMs: 30_000 });
    const after = await world.probe(rileyMini);
    const mine = await world.mine();
    expect(after).toEqual({ work: "403 computer_disconnected", signIn: "401 unauthorized", token: "401 unauthorized", report: "401 unauthorized" });
    expect(mine.find((device) => device.id === rileyMini.deviceId)).toMatchObject({ canDisconnect: false, canRemove: true });
    expect((await world.memberRequest("/v1/me")).response.status).toBe(200);
    evidence.recordAssertionEvidence("Owners can disconnect their own computers", `Mac mini after: ${JSON.stringify(after)}; Riley's own browser sign-in still works; activity on the first computer reads "${events[0]?.message}"`, after.work === "403 computer_disconnected");
    await member.screenshot();
  });

  await step("only the right people can: a member cannot touch a colleague's computer or the admin action", async () => {
    const colleague = await world.memberRequest(`/v1/remote-devices/${alexMac.deviceId}/disconnect`, {});
    const asAdmin = await world.memberRequest(`/v1/org/computers/${alexMac.deviceId}/disconnect`, {});
    const removeLive = await world.adminRequest(`/v1/org/computers/${alexMac.deviceId}`, undefined, "DELETE");
    expect(colleague.response.status).toBe(404);
    expect(asAdmin.response.status).toBe(403);
    expect(removeLive.response.status).toBe(409);
    expect(world.errorOf(removeLive.body)).toBe("disconnect_first");
    expect((await world.probe(alexMac)).work).toBe("200");
    evidence.recordAssertionEvidence("Scoped and permissioned", `member on a colleague's computer=${colleague.response.status}; member on the admin route=${asAdmin.response.status}; removing a live computer=${removeLive.response.status} ${world.errorOf(removeLive.body)}; that computer still works`, colleague.response.status === 404 && asAdmin.response.status === 403 && removeLive.response.status === 409);
  });

  await step("signing in on the computer again is what reconnects it", async () => {
    const reconnected = await world.signInAgain(rileyMac, "member");
    const now = await world.probe(reconnected);
    const record = await row(rileyMac.deviceId);
    const events = await world.activity(rileyMac.deviceId);
    expect(now).toEqual({ work: "200", signIn: "200", token: "200", report: "200" });
    expect(record).toMatchObject({ disconnectedAt: null, canDisconnect: true });
    expect(events.map((event) => event.type)).toContain("restored");
    await member.reload();
    await member.see({ role: "heading", label: "My Computers" }, { timeoutMs: 60_000 });
    await member.see({ text: "Online" }, { timeoutMs: 60_000 });
    evidence.recordAssertionEvidence("A new sign-in reconnects", `after signing in again: ${JSON.stringify(now)}; activity includes "${events.find((event) => event.type === "restored")?.message}"`, now.work === "200" && record?.disconnectedAt === null);
    await member.screenshot();
  });

  await step("an admin clears a leaver's computer from the list", async () => {
    await admin.click({ testId: `computer-menu-${world.devices.jordanMac.id}` });
    await admin.click({ testId: `computer-remove-${world.devices.jordanMac.id}` });
    await admin.see({ text: "Remove Jordan's MacBook Air from the list?" }, { timeoutMs: 30_000 });
    await admin.click({ testId: "confirm-dialog-action" });
    await probe.eventually(async () => (await world.list()).devices.some((device) => device.id === world.devices.jordanMac.id), { within: 30_000, until: (listed) => !listed, label: "the leaver's computer is off the list" });
    await admin.see({ text: "Removed Jordan's MacBook Air from the list" }, { timeoutMs: 30_000 });
    await probe.eventually(async () => (await adminProbe.dom(`[data-testid="computer-row-${world.devices.jordanMac.id}"]`)).elements.length, { within: 30_000, until: (count) => count === 0, label: "its row is gone" });
    const remaining = (await world.list("?stale=include")).devices.map((device) => device.label);
    expect(remaining).not.toContain("Jordan's MacBook Air");
    evidence.recordAssertionEvidence("Removal is separate and only where it sticks", `still listed: ${remaining.join(", ")}; a live computer has to be disconnected first`, !remaining.includes("Jordan's MacBook Air"));
  });

  await step("with the grey sidebar feature on, the same pages sit on white beside a grey sidebar", async () => {
    const shell = async (surface: typeof adminProbe) => (await surface.dom("[data-den-shell]")).elements.length;
    expect(await shell(adminProbe)).toBe(0);
    await world.setFeature("denGreySidebar", true);
    await admin.reload();
    await admin.see({ role: "heading", label: "Computers" }, { timeoutMs: 60_000 });
    await probe.eventually(() => shell(adminProbe), { within: 30_000, until: (count) => count === 1, label: "the shell marks itself grey" });
    await admin.screenshot();
    await member.reload();
    await member.see({ role: "heading", label: "My Computers" }, { timeoutMs: 60_000 });
    await probe.eventually(() => shell(memberProbe), { within: 30_000, until: (count) => count === 1, label: "the member's shell is grey too" });
    await member.screenshot();
    await world.setFeature("denGreySidebar", false);
    await admin.reload();
    await admin.see({ role: "heading", label: "Computers" }, { timeoutMs: 60_000 });
    const restored = await probe.eventually(() => shell(adminProbe), { within: 30_000, until: (count) => count === 0, label: "turning it off restores the earlier colours" });
    expect(restored).toBe(0);
    evidence.recordAssertionEvidence("Colours only, and reversible", `denGreySidebar on: the shell marks itself and the pages render on white; off: marked shells=${restored}`, restored === 0);
  });

});
