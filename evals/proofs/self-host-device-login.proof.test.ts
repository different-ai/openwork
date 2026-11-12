import { expect } from "vitest";
import { selfHostServer, spec } from "@openwork/testkit";
import { selfHostDeviceLogin } from "../worlds/self-host-install.ts";

const test = spec.world((seed, context) => selfHostDeviceLogin(seed, context, selfHostServer), {
  resources: { surfaces: ["web"], services: ["den"] },
  needs: { placement: "local" },
  timeout: 900_000,
});

test("an owner approves a separate device session on an operator-installed private server", async ({ world, user, probe, evidence, step }) => {
  const browser = user.on(world.web);
  await step("before: a device awaiting private-server approval has no session", async () => {
    await browser.navigate(world.verificationUrl);
    await browser.see({ testId: "device-desktop-consent-line" }, { timeoutMs: 90_000 });
    const pending = await world.redeem();
    expect(pending.error).toBe("authorization_pending");
    expect(pending.freshSession).toBe(false);
    evidence.recordAssertionEvidence("Private-server device requests start pending", `token endpoint=${String(pending.error)}; session issued=false`, pending.error === "authorization_pending");
    await browser.screenshot();
  });
  await step("the owner compares the code and approves the private organization", async () => {
    await browser.see({ text: world.userCode.replace(/^([^-]{4})([^-]{4})$/, "$1-$2") });
    await browser.see({ text: world.organizationName });
    await browser.notSee({ role: "button", label: "Organization" });
    await browser.notSee({ text: "Choose an organization" });
    await browser.see({ testId: "device-desktop-consent-line" }, { text: new RegExp(world.organizationName) });
    expect((await probe.on(world.web).dom('[data-testid="device-approve"]:not([disabled])')).elements).toHaveLength(1);
    await browser.click({ role: "button", label: "Approve" });
    await browser.see({ text: "Return to the OpenWork app on that computer." }, { timeoutMs: 30_000 });
    const visible = await probe.on(world.web).text();
    evidence.recordAssertionEvidence("Private-server approval returns to the remote app, not laptop loopback", "approved on the actual Den /device page; browser remains on the private server", visible.includes("Return to the OpenWork app on that computer."));
    await browser.screenshot();
  });
  await step("after: the private server issues an independent session bound to the approved organization", async () => {
    const session = await probe.eventually(() => world.redeem(), {
      within: 45_000, intervalMs: 5_000, label: "the private server issues the approved device session", until: value => value.status === 200,
    });
    expect(session.status).toBe(200);
    expect(session.freshSession).toBe(true);
    expect(session.email).toBe(world.email);
    expect(session.organizationId).toBe(world.organizationId);
    await browser.see({ text: "Return to the OpenWork app on that computer." });
    evidence.recordAssertionEvidence("Compatibility target B issues a fresh device session", `HTTP ${session.status}; distinct browser session=${session.freshSession}; chosen private organization=true`, session.freshSession && session.organizationId === world.organizationId);
  });
});
