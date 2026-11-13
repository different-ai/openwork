import { expect } from "vitest";
import { z } from "zod";
import { spec } from "@openwork/testkit";
import { remoteDevicesWorkbotWorld } from "../worlds/remote-devices-workbot.ts";

const test = spec.world(remoteDevicesWorkbotWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

const listSchema = z.object({ devices: z.array(z.object({ label: z.string(), provider: z.string(), availability: z.string(), statusDetail: z.string().nullable() })) });

test("a person sees only their Workbot computers, including an honest unavailable state, while Devices is enabled", async ({ world, user, probe, step, evidence }) => {
  const person = user.on(world.web);
  const personProbe = probe.on(world.web);

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

});
