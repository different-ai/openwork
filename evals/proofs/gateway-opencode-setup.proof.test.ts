import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { gatewayCursorSetupWorld, gatewayOpenCodeSetupWorld } from "../worlds/gateway-cursor-setup.ts";

const off = spec.world(gatewayCursorSetupWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den", "mock"] } });
const on = spec.world(gatewayOpenCodeSetupWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den", "mock"] } });
const setup = { testId: "gateway-tool-setup-opencode" };

off("a member keeps the existing setup options before OpenCode rolls out", async ({ user, probe, step, evidence }) => {
  await step("before: the setup row has Cursor but no OpenCode option", async () => {
    await user.see({ testId: "gateway-tool-setup-cursor" }, { timeoutMs: 60_000 });
    const entries = await probe.dom('[data-testid="gateway-tool-setup-opencode"]');
    evidence.recordAssertionEvidence("OpenCode is not offered before rollout", `OpenCode buttons: ${entries.elements.length}`, entries.elements.length === 0);
    expect(entries.elements).toHaveLength(0);
    await user.screenshot();
  });
});

on("a member can set up the OpenCode plugin without creating an API key", async ({ user, probe, step, evidence }) => {
  await step("after: OpenCode appears alongside the other setup options", async () => {
    await user.see(setup, { timeoutMs: 60_000 });
    const entries = await probe.dom('[data-testid="gateway-tool-setup-opencode"]');
    evidence.recordAssertionEvidence("OpenCode has a setup button", `OpenCode buttons: ${entries.elements.length}`, entries.elements.length === 1);
    expect(entries.elements).toHaveLength(1);
    await user.screenshot();
  });

  await step("when the member opens OpenCode setup, they can copy the plugin install command", async () => {
    await user.click(setup);
    await user.see({ role: "button", name: "Copy install command" });
    const command = (await probe.dom('[data-testid="gateway-tool-opencode-install"]')).elements[0]?.text;
    evidence.recordAssertionEvidence("The dialog shows the published plugin install command", command ?? "Install command missing", command === "opencode plugin add opencode-openwork");
    expect(command).toBe("opencode plugin add opencode-openwork");
  });

  await step("then the member sees browser sign-in without a create-key step", async () => {
    await user.see({ role: "button", name: "Copy sign-in command" });
    const command = (await probe.dom('[data-testid="gateway-tool-opencode-sign-in"]')).elements[0]?.text;
    const keyButtons = (await probe.dom('[data-testid="gateway-tool-setup-create-key"]')).elements.length;
    const expected = "opencode auth login openwork --method browser --standalone";
    evidence.recordAssertionEvidence("The dialog shows browser sign-in instead of creating an API key", `${command ?? "Sign-in command missing"}; create-key buttons: ${keyButtons}`, command === expected && keyButtons === 0);
    expect(command).toBe(expected);
    expect(keyButtons).toBe(0);
    await user.screenshot();
  });
});
