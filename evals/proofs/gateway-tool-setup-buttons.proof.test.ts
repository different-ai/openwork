import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { gatewayCursorSetupWorld } from "../worlds/gateway-cursor-setup.ts";

const test = spec.world(gatewayCursorSetupWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

test("My Library › Models sets up each tool from its logo, creating a key that fills into the steps", async ({ user, probe, step, evidence }) => {
  await step("the section is renamed and shows a logo button per tool", async () => {
    await user.see({ testId: "gateway-tool-setup-row" }, { timeoutMs: 60_000 });
    await user.see({ text: "Use OpenWork AI Gateway with other tools" });
    const buttons = await probe.dom('[data-testid^="gateway-tool-setup-"][aria-label^="Set up"]');
    evidence.recordAssertionEvidence("One button per tool", `buttons=${buttons.elements.length}`, buttons.elements.length === 6);
    expect(buttons.elements).toHaveLength(6);
    await user.screenshot();
  });

  await step("Claude Code opens its steps with a way to create a key", async () => {
    await user.click({ testId: "gateway-tool-setup-claude-code" });
    await user.see({ testId: "gateway-tool-setup-dialog" });
    await user.see({ testId: "gateway-tool-setup-create-key" });
    await user.see({ testId: "gateway-tool-claude-code-settings" }, { timeoutMs: 30_000 });
    await user.screenshot();
  });

  await step("creating the key fills it into the settings to copy", async () => {
    await user.click({ testId: "gateway-tool-setup-create-key" });
    await user.see({ testId: "gateway-tool-setup-key-secret" }, { timeoutMs: 30_000 });
    const secret = (await probe.dom('[data-testid="gateway-tool-setup-key-secret"]')).elements[0]?.text ?? "";
    const settings = (await probe.dom('[data-testid="gateway-tool-claude-code-settings"]')).elements[0]?.text ?? "";
    evidence.recordAssertionEvidence("The new key is in the Claude Code settings", `key shown=${secret.length > 0}; in settings=${settings.includes(secret)}`, secret.length > 0 && settings.includes(secret));
    expect(settings).toContain(secret);
    await user.screenshot();
  });

  await step("Cursor shows its own steps", async () => {
    await user.press("Escape");
    await user.click({ testId: "gateway-tool-setup-cursor" });
    await user.see({ testId: "gateway-tool-cursor" });
    await user.screenshot();
  });
});
