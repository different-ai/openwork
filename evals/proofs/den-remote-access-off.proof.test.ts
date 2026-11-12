import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denRemoteAccessOffWorld } from "../worlds/den-remote-access-off.ts";

const test = spec.world(denRemoteAccessOffWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("nothing reaches a computer until its owner allows it, the owner can turn a computer off again, and the organization can turn it off for everyone", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.owner), member = user.on(world.member), memberProbe = probe.on(world.member);
  const { macbook, mini, imac } = world.computers;
  const errorOf = (result: Record<string, unknown>) => typeof result.error === "string" ? result.error : "";
  const messageOf = (result: Record<string, unknown>) => typeof result.message === "string" ? result.message : "";
  const idOf = async (label: string) => (await world.targets()).find((computer) => computer.label === label)?.computerId ?? "";
  const reach = async () => Object.fromEntries((await world.devices()).map((device) => [device.label, device.remoteAccess ? `${device.remoteAccess.effective}${device.remoteAccess.reason ? ` (${device.remoteAccess.reason})` : ""}` : "none"]));

  await step("with the opt-in, only the computer its owner allowed takes tasks, and Den says why for the others", async () => {
    await member.see({ text: "Fieldnotes Studio" }, { timeoutMs: 60_000 });
    await member.click({ testId: "dashboard-nav-my-computers" });
    await member.see({ role: "heading", label: "My Computers" }, { timeoutMs: 60_000 });
    for (const text of ["Riley's MacBook Pro", "Riley's Mac mini", "Riley's old iMac", "Other devices can", "Start tasks", "Not allowed yet. Allow it in Settings › Devices on that computer.", "Update OpenWork on this computer to allow it."]) await member.see({ text }, { timeoutMs: 30_000 });
    const before = await reach();
    const targets = await world.targets();
    expect(before).toEqual({ "Riley's MacBook Pro": "off (not_chosen)", "Riley's Mac mini": "created", "Riley's old iMac": "off (update_required)" });
    expect(Object.fromEntries(targets.map((computer) => [computer.label, computer.access]))).toEqual({ "Riley's MacBook Pro": "off", "Riley's Mac mini": "created", "Riley's old iMac": "off" });
    expect((await memberProbe.dom('[data-remote-access="off"]')).elements.length).toBeGreaterThanOrEqual(2);
    evidence.recordAssertionEvidence("Off until allowed", JSON.stringify(before), before["Riley's MacBook Pro"] === "off (not_chosen)" && before["Riley's Mac mini"] === "created");
    await member.screenshot();
  });

  await step("a task for a computer that is off is refused with where to allow it; an unaddressed task goes to the allowed one", async () => {
    const toMacbook = await world.startTask("Summarize field notes", await idOf("Riley's MacBook Pro"));
    const toImac = await world.startTask("Summarize field notes", await idOf("Riley's old iMac"));
    const anywhere = await world.startTask("Summarize field notes");
    expect(errorOf(toMacbook)).toBe("remote_access_off");
    expect(messageOf(toMacbook)).toContain("Settings > Devices");
    expect(errorOf(toImac)).toBe("remote_access_off");
    expect(messageOf(toImac)).toContain("Update OpenWork");
    expect(errorOf(anywhere)).toBe("");
    expect(anywhere.computerId).toBe(await idOf("Riley's Mac mini"));
    await probe.eventually(async () => mini.delivered.length, { within: 60_000, until: (count) => count === 1, label: "the task runs on the allowed computer" });
    expect(macbook.delivered).toEqual([]);
    expect(imac.delivered).toEqual([]);
    evidence.recordAssertionEvidence("Refused up front, and never sent to a computer that is off", `MacBook: ${errorOf(toMacbook)} "${messageOf(toMacbook)}"; old iMac: ${errorOf(toImac)} "${messageOf(toImac)}"; unaddressed task ran on the Mac mini; tasks delivered: MacBook ${macbook.delivered.length}, iMac ${imac.delivered.length}, Mac mini ${mini.delivered.length}`, errorOf(toMacbook) === "remote_access_off" && macbook.delivered.length === 0 && mini.delivered.length === 1);
    await member.screenshot();
  });

  await step("allowing a computer makes it take tasks; turning one off cuts its sessions off and turning it on brings them back", async () => {
    await world.choose(macbook, "created");
    await probe.eventually(() => reach(), { within: 30_000, until: (now) => now["Riley's MacBook Pro"] === "created", label: "the MacBook is allowed" });
    const toMacbook = await world.startTask("Draft the trip report", await idOf("Riley's MacBook Pro"));
    expect(errorOf(toMacbook)).toBe("");
    await probe.eventually(async () => macbook.delivered.length, { within: 60_000, until: (count) => count === 1, label: "the task runs on the MacBook" });

    await world.choose(mini, "off");
    await probe.eventually(() => reach(), { within: 30_000, until: (now) => now["Riley's Mac mini"] === "off", label: "the Mac mini is off" });
    const cut = await world.request("member", "/v1/remote-sessions/send", { sessionId: mini.delivered[0], workspaceId: world.workspaceId, prompt: "Add the budget section." });
    const blocked = await world.startTask("Summarize field notes", await idOf("Riley's Mac mini"));
    expect(cut.response.status).toBe(409);
    expect(errorOf(blocked)).toBe("remote_access_off");
    expect(mini.followUps).toEqual([]);
    await member.reload();
    await member.see({ role: "heading", label: "My Computers" }, { timeoutMs: 60_000 });
    await member.see({ text: "Turned off on that computer." }, { timeoutMs: 30_000 });
    await member.screenshot();

    await world.choose(mini, "created");
    await probe.eventually(() => reach(), { within: 30_000, until: (now) => now["Riley's Mac mini"] === "created", label: "the Mac mini is allowed again" });
    const again = await world.request("member", "/v1/remote-sessions/send", { sessionId: mini.delivered[0], workspaceId: world.workspaceId, prompt: "Add the budget section." });
    await probe.eventually(async () => mini.followUps.length, { within: 60_000, until: (count) => count === 1, label: "the follow-up reaches the Mac mini" });
    expect(again.response.ok).toBe(true);
    evidence.recordAssertionEvidence("The owner decides per computer, both ways", `send while off=${cut.response.status}; new task while off=${errorOf(blocked)}; follow-ups the Mac mini received while off=0, after turning it on=${mini.followUps.length}`, cut.response.status === 409 && mini.followUps.length === 1);
  });

  await step("an organization owner turns remote access off for everyone", async () => {
    const memberPatch = await world.request("member", "/v1/org/remote-session-settings", { access: "off" }, "PATCH");
    const adminPatch = await world.request("manager", "/v1/org/remote-session-settings", { access: "off" }, "PATCH");
    const widen = await world.request("owner", "/v1/org/remote-session-settings", { access: "all" }, "PATCH");
    expect(memberPatch.response.status).toBe(403);
    expect(adminPatch.response.status).toBe(403);
    expect(widen.response.status).toBe(409);
    await owner.see({ text: "Manage" }, { timeoutMs: 60_000 });
    await owner.click({ testId: "dashboard-nav-computers" });
    await owner.see({ role: "heading", label: "Computers" }, { timeoutMs: 60_000 });
    await owner.see({ testId: "session-access-setting" }, { timeoutMs: 30_000 });
    await owner.click({ testId: "session-access-select" });
    await owner.notSee({ testId: "session-access-all" });
    await owner.click({ testId: "session-access-off" });
    await probe.eventually(async () => (await world.settings("owner")).settings.access, { within: 30_000, until: (access) => access === "off", label: "the organization is off" });
    await owner.see({ text: "Saved. Other devices can no longer reach any computer in this organization." }, { timeoutMs: 30_000 });
    await owner.screenshot();
    const refused = await world.startTask("Summarize field notes");
    const cut = await world.request("member", "/v1/remote-sessions/send", { sessionId: macbook.delivered[0], workspaceId: world.workspaceId, prompt: "One more thing." });
    await probe.eventually(async () => world.computers.macbook.ceiling, { within: 30_000, until: (ceiling) => ceiling === "off", label: "the computers are told" });
    expect(errorOf(refused)).toBe("remote_access_off");
    expect(messageOf(refused)).toBe("Your organization has turned off tasks from other devices.");
    expect(cut.response.status).toBe(409);
    const under = await reach();
    expect(under).toEqual({ "Riley's MacBook Pro": "off (organization)", "Riley's Mac mini": "off (organization)", "Riley's old iMac": "off (organization)" });
    await member.reload();
    await member.see({ role: "heading", label: "My Computers" }, { timeoutMs: 60_000 });
    await member.see({ text: "Your organization has turned this off." }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("The organization's Off wins", `member PATCH=${memberPatch.response.status}; admin PATCH=${adminPatch.response.status}; "all" without its feature=${widen.response.status}; new task: ${errorOf(refused)} "${messageOf(refused)}"; follow-up=${cut.response.status}; every computer reads ${under["Riley's MacBook Pro"]}; computers told ceiling=${world.computers.macbook.ceiling}`, errorOf(refused) === "remote_access_off" && cut.response.status === 409);
    await member.screenshot();
  });

  await step("without the opt-in nothing changes for a computer whose owner never chose", async () => {
    await owner.click({ testId: "session-access-select" });
    await owner.click({ testId: "session-access-created" });
    await probe.eventually(async () => (await world.settings("owner")).settings.access, { within: 30_000, until: (access) => access === "created", label: "the organization allows remotely started tasks again" });
    await world.setFeature("remoteTasksOptIn", false);
    const toImac = await world.startTask("Archive last month's notes", await idOf("Riley's old iMac"));
    expect(errorOf(toImac)).toBe("");
    await probe.eventually(async () => imac.delivered.length, { within: 60_000, until: (count) => count === 1, label: "the older app takes the task, as before" });
    evidence.recordAssertionEvidence("Opt-in off is today's behaviour", `task for the older app: ${errorOf(toImac) || "accepted"}; delivered=${imac.delivered.length}`, imac.delivered.length === 1);
  });
});
