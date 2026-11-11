import { expect } from "vitest";
import { z } from "zod";
import { spec } from "@openwork/testkit";
import { remoteDevicesWorkbotWorld } from "../worlds/remote-devices-workbot.ts";

const test = spec.world(remoteDevicesWorkbotWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

const listSchema = z.object({ devices: z.array(z.object({ label: z.string(), provider: z.string(), availability: z.string(), statusDetail: z.string().nullable() })) });

test("a person sees their computers in Workbot, and a platform admin sees why one of them is not responding", async ({ world, user, probe, step, evidence }) => {
  const person = user.on(world.web);
  const personProbe = probe.on(world.web);
  const admin = user.on(world.admin);
  const adminProbe = probe.on(world.admin);

  // Workbot checks sign-in on load rather than polling: a changed rollout shows on the next load once its server reports it.
  const reloadWhenDevices = async (enabled: boolean) => {
    await probe.eventually(async () => {
      const me = await world.call("/v1/workbot/me");
      return me.ok ? z.object({ devices: z.boolean() }).parse(await me.json()).devices : null;
    }, { within: 65_000, until: value => value === enabled, label: `Workbot reports Devices ${enabled ? "on" : "off"}` });
    await person.reload();
  };
  const listed = async () => {
    const response = await world.call("/v1/workbot/devices");
    return response.ok ? listSchema.parse(await response.json()).devices : null;
  };

  await step("before: Workbot has no Devices page and its server refuses the list", async () => {
    await person.see({ text: "Acme AI Gateway is working." });
    await person.notSee({ role: "button", label: "Devices" });
    const refused = await world.call("/v1/workbot/devices");
    evidence.recordAssertionEvidence("Devices is off until it is rolled out", `GET /v1/workbot/devices → ${refused.status}; no Devices entry in the navigation`, refused.status === 403);
    expect(refused.status).toBe(403);
    await person.screenshot();
  });

  await step("after: Devices lists the person's own Mac and the Mac sandbox their admin shared", async () => {
    await world.setEnabled(true);
    await world.desktopSignsIn();
    await world.shareMacSandbox();
    await reloadWhenDevices(true);
    await person.click({ role: "button", label: "Devices" });
    await person.see({ text: "Alex's MacBook Pro" }, { timeoutMs: 30_000 });
    await person.see({ text: "Design review Mac" });
    await person.see({ text: "Shared with your organization" });
    const online = await personProbe.dom('[data-workbot-device="online"]');
    const unchecked = await personProbe.dom('[data-workbot-device="unknown"]');
    const ok = online.elements.length === 1 && unchecked.elements.length === 1 && new URL(await personProbe.url()).pathname === "/devices";
    evidence.recordAssertionEvidence("One list for the person's computers", `online rows=${online.elements.length} (the Mac that just reported); not checked yet=${unchecked.elements.length} (the shared sandbox nobody has probed); path /devices`, ok);
    expect(ok).toBe(true);
    await person.screenshot();
  });

  await step("after: Workbot's own computer joins the list when the person opens it, and says it did not respond", async () => {
    await person.navigate(new URL("/computer", await personProbe.url()).toString());
    // This fixture has no desktop provider, so the view cannot connect: the honest failure the registry should record.
    await person.see({ text: "Your computer is unavailable. Try reconnecting." }, { timeoutMs: 30_000 });
    const devices = await probe.eventually(listed, { within: 30_000, until: value => value?.some(device => device.provider === "workbot") === true, label: "Workbot's computer is reported to Den" });
    const computer = devices?.find(device => device.provider === "workbot");
    await person.click({ role: "button", label: "Devices" });
    await person.reload();
    await person.see({ text: "Workbot's computer" }, { timeoutMs: 30_000 });
    await person.see({ text: "Did not respond" });
    const ok = computer?.availability === "offline" && computer.statusDetail === "Did not respond";
    evidence.recordAssertionEvidence("A failed connection is on the record, in plain words", `Workbot's computer: availability=${computer?.availability}; detail=${computer?.statusDetail}`, ok);
    expect(ok).toBe(true);
    await person.screenshot();
  });

  await step("a platform admin finds the same computers in /admin, with the one that has problems marked", async () => {
    await admin.navigate(world.adminUrl(`/admin/devices?organizationId=${world.organizationId}`));
    await admin.see({ role: "heading", label: "Devices" }, { timeoutMs: 60_000 });
    await admin.see({ text: "Alex's MacBook Pro" }, { timeoutMs: 30_000 });
    await admin.see({ text: "Design review Mac" });
    await admin.see({ text: "Shared with the organization" });
    await admin.see({ testId: "admin-devices-problems" });
    const rows = await adminProbe.dom('[data-testid^="admin-device-row-"]');
    const devices = await world.adminDevices();
    const troubled = devices.filter(device => device.recentProblems > 0).map(device => device.label);
    const ok = rows.elements.length === 3 && troubled.length === 1 && troubled[0] === "Workbot's computer";
    evidence.recordAssertionEvidence("Every computer of the organization, one with problems", `rows=${rows.elements.length}; with problems in the last 24 hours: ${troubled.join(", ")}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("opening that computer shows what happened, the fixed code, and which features its owner has", async () => {
    const computer = (await world.adminDevices()).find(device => device.provider === "workbot");
    if (!computer) throw new Error("Workbot's computer is missing from /admin.");
    await admin.click({ testId: `admin-device-row-${computer.id}` });
    await admin.see({ testId: `admin-device-detail-${computer.id}` }, { timeoutMs: 30_000 });
    await admin.see({ text: "Workbot started using this computer" }, { timeoutMs: 30_000 });
    await admin.see({ text: "code=desktop_unavailable" });
    const failures = await adminProbe.dom('[data-testid^="admin-device-event-"][data-level="error"]');
    const devicesOn = await adminProbe.dom('[data-testid="admin-device-feature-remoteDevices"]');
    const ok = failures.elements.length >= 1 && devicesOn.elements.length === 1 && devicesOn.elements[0]?.text.includes("On") === true;
    evidence.recordAssertionEvidence("The device's own record explains its state", `error events=${failures.elements.length}, each "Did not respond" with code desktop_unavailable; Devices for the owner: ${devicesOn.elements[0]?.text ?? "missing"}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("turning Devices off removes the page from Workbot, while /admin keeps the record", async () => {
    await world.setEnabled(false);
    await person.navigate(new URL("/", await personProbe.url()).toString());
    await reloadWhenDevices(false);
    await person.see({ text: "Acme AI Gateway is working." });
    await person.notSee({ role: "button", label: "Devices" });
    const refused = await world.call("/v1/workbot/devices");
    const kept = await world.adminDevices();
    const ok = refused.status === 403 && kept.length === 3;
    evidence.recordAssertionEvidence("Off for people, still readable for platform admins", `GET /v1/workbot/devices → ${refused.status}; /admin still lists ${kept.length} computers`, ok);
    expect(ok).toBe(true);
    await person.screenshot();
  });
});
