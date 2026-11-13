import { expect } from "vitest";
import { z } from "zod";
import { spec } from "@openwork/testkit";
import { remoteDevicesDesktopWorld } from "../worlds/remote-devices-desktop.ts";

const test = spec.world(remoteDevicesDesktopWorld, { timeout: 600_000, resources: { surfaces: ["appWeb"], services: ["den"] }, needs: { commands: ["bun"] } });

test("a person manages virtual computers beside their signed-in desktops without exposing private computers to a teammate", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("after: Settings lists the person's Mac with what it needs and the shared Mac sandbox", async () => {
    await user.navigate(world.settingsUrl);
    await user.see({ text: "Avery's MacBook" }, { timeoutMs: 60_000 });
    await user.see({ text: "Screen Recording is off" });
    await user.see({ text: "Team Mac sandbox" });
    await user.see({ role: "button", label: "Add a computer" });
    const text = await probe.text();
    const visible = text.includes("Avery's MacBook") && text.includes("Screen Recording is off") && text.includes("Team Mac sandbox");
    evidence.recordAssertionEvidence("The real signed-in settings page reads Den's registry", "Avery's MacBook: Needs setup, Screen Recording is off; Team Mac sandbox: Not checked yet", visible);
    expect(visible).toBe(true);
    await user.screenshot();
  });
  await step("adding a Freestyle VM names it in the list without pretending it is connected", async () => {
    await user.click({ role: "button", label: "Add a computer" });
    await user.type({ role: "textbox", label: "Name" }, "Build VM");
    await user.type({ role: "textbox", label: "ID from the provider" }, "vm-proof-build");
    await user.click({ role: "button", label: "Add computer" });
    await user.see({ text: "Build VM" }, { timeoutMs: 30_000 });
    const body = await probe.text();
    const ok = body.includes("Build VM") && body.includes("Not checked yet");
    evidence.recordAssertionEvidence("A registered VM is not an invented live connection", "Build VM is listed; availability is Not checked yet; no provider credentials were supplied", ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });
  await step("a teammate sees only the shared sandbox, never the person's desktop or private VM", async () => {
    await user.see({ text: "Build VM" });
    const devices = z.object({ devices: z.array(z.object({ label: z.string() })) }).parse(await world.memberList()).devices;
    const names = devices.map(device => device.label);
    const ok = names.length === 1 && names[0] === "Team Mac sandbox";
    evidence.recordAssertionEvidence("Device access stays scoped to its owner", `Teammate's list: ${names.join(", ")}; Avery's MacBook and Build VM absent`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

});
