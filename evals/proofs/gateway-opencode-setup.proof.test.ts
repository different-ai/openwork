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

on("a member can copy an OpenCode configuration for their gateway models", async ({ user, probe, step, evidence }) => {
  await step("after: OpenCode appears alongside the other setup options", async () => {
    await user.see(setup, { timeoutMs: 60_000 });
    const entries = await probe.dom('[data-testid="gateway-tool-setup-opencode"]');
    evidence.recordAssertionEvidence("OpenCode has a setup button", `OpenCode buttons: ${entries.elements.length}`, entries.elements.length === 1);
    expect(entries.elements).toHaveLength(1);
    await user.screenshot();
  });

  await step("when the member opens OpenCode setup, they can see how to set their key", async () => {
    await user.click(setup);
    await user.see({ testId: "gateway-tool-opencode-env" });
    const field = (await probe.dom('[data-testid="gateway-tool-opencode-env"]')).elements[0]?.text ?? "";
    evidence.recordAssertionEvidence("The instructions name the key variable", "The shell command uses OPENWORK_API_KEY", field.includes('OPENWORK_API_KEY="<your API key>"'));
    expect(field).toContain('OPENWORK_API_KEY="<your API key>"');
  });

  await step("then the member gets a config with a default model and no embedded key", async () => {
    await user.see({ testId: "gateway-tool-opencode-config" }, { timeoutMs: 30_000 });
    const config = (await probe.dom('[data-testid="gateway-tool-opencode-config"]')).elements[0]?.text ?? "";
    const model = config.match(/"model": "openwork\/(gwm_[^"]+)"/)?.[1];
    const ok = Boolean(model && config.includes(`"${model}": {`) && config.includes('"apiKey": "{env:OPENWORK_API_KEY}"') && config.includes('"npm": "@ai-sdk/openai-compatible"'));
    evidence.recordAssertionEvidence("The config selects an available model and reads the key from the environment", `default model present: ${Boolean(model)}; provider and key reference validated: ${ok}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });
});
