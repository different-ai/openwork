import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { providerCredentialStatus } from "../worlds/provider-credential-status.ts";

const test = spec.world(providerCredentialStatus, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: [] },
  needs: { commands: ["bun"] },
});
const WITHIN = 60_000;

test("a person sees a rejected personal provider key, replaces it, and earns Ready to use only after a successful request", async ({ world, user, probe, step, evidence }) => {
  const row = async () => (await probe.dom(`[data-testid="local-provider-${world.providerId}"]`)).elements.map(element => element.text).join(" ");
  const status = (text: string) => probe.eventually(row, { within: WITHIN, label: `the provider says ${text}`, until: value => value.includes(text) });
  async function saveKey(key: string) {
    await user.see({ label: "API key" }, { timeoutMs: WITHIN });
    await user.type({ label: "API key" }, key, { replace: true });
    await user.click({ role: "button", label: "Save key" });
    await user.notSee({ role: "button", label: "Save key" }, { timeoutMs: WITHIN });
  }
  async function send(prompt: string) {
    await user.navigate(world.composerUrl);
    await user.see("composer", { editable: true, timeoutMs: WITHIN });
    // This isolated workspace has exactly one available model. Confirm the
    // selected model through the visible picker trigger before sending.
    const selection = await probe.eventually(async () => (await probe.dom('button[aria-label="Change model"]')).elements.map(element => element.text).join(" "), {
      within: WITHIN, label: "the local fault model is selected", until: value => value.includes("Credential proof model"),
    });
    expect(selection).toContain("Credential proof model");
    await user.type("composer", prompt);
    await user.click("Run task");
  }
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  await step("before: saving a personal key says Not checked yet, not Ready to use", async () => {
    await user.reload();
    await user.navigate(world.settingsUrl);
    await user.see({ role: "button", label: "Connect a provider" }, { timeoutMs: WITHIN });
    await user.click({ role: "button", label: "Connect a provider" });
    await user.type({ label: "Search providers" }, "Fault Lab");
    await user.click({ role: "button", label: /^Fault Lab/ });
    await saveKey(world.rejectedKey);
    // Reopening must not turn mere configuration/catalog discovery into proof
    // that this never-used credential works.
    await user.reload();
    const text = await status("Not checked yet");
    expect(text).not.toContain("Ready to use");
    expect(world.requests()).toHaveLength(0);
    evidence.recordAssertionEvidence("Saving is not verification", `${text}; native upstream requests=${world.requests().length}`, !text.includes("Ready to use") && world.requests().length === 0);
    await user.screenshot();
  });

  await step("a real chat request reaches the provider and receives User not found with HTTP 401", async () => {
    await send("Reply with one short greeting.");
    const requests = await probe.eventually(() => world.requests(), {
      within: WITHIN, label: "the native engine reaches the loopback provider", until: values => values.some(value => value.status === 401),
    });
    // Copy is outside this status-only proof; engines can surface the same
    // rejection through the existing friendly card or their plain message.
    await user.see({ text: /Check your model connection|User not found/ }, { timeoutMs: WITHIN });
    expect(requests.some(value => value.status === 401 && value.credential === "original" && value.model === world.modelId)).toBe(true);
    expect(requests.some(value => value.status === 200)).toBe(false);
    const native = await world.nativeFailure();
    expect(native.some(error => error.status === 401)).toBe(true);
    evidence.recordAssertionEvidence("The native engine really received a credential rejection", JSON.stringify({ requests, native }), requests.some(value => value.status === 401 && value.credential === "original" && value.model === world.modelId));
    await user.screenshot();
  });

  await step("after: AI Providers says Key not accepted and offers Replace key instead of Ready to use", async () => {
    await user.navigate(world.settingsUrl);
    const text = await status("Key not accepted");
    expect(text).not.toContain("Ready to use");
    expect(text).toContain("Replace key");
    await user.see({ role: "button", label: "Replace key" });
    evidence.recordAssertionEvidence("Settings distinguishes a rejected key from a configured provider", text, text.includes("Replace key") && !text.includes("Ready to use"));
    await user.screenshot();
  });

  await step("the rejection survives reopening Settings", async () => {
    await user.reload();
    const text = await status("Key not accepted");
    expect(text).not.toContain("Ready to use");
    expect(text).toContain("Replace key");
    evidence.recordAssertionEvidence("Reload does not erase the observed rejection", text, text.includes("Key not accepted") && text.includes("Replace key") && !text.includes("Ready to use"));
    await user.screenshot();
  });

  await step("Replace key opens the rejected provider's own key editor", async () => {
    await user.click({ role: "button", label: "Replace key" });
    await user.see({ label: "API key" }, { timeoutMs: WITHIN });
    const dialog = (await probe.dom('[role="dialog"]')).elements.map(element => element.text).join(" ");
    expect(dialog).toContain("Fault Lab");
    expect(dialog).toContain(world.providerId);
    await user.see({ role: "button", label: "Save key" });
    evidence.recordAssertionEvidence("Replacement targets Fault Lab without asking the member to find it again", dialog, dialog.includes("Fault Lab") && dialog.includes(world.providerId));
    await user.screenshot();
  });

  await step("saving a replacement clears the rejection but does not claim the untested key works", async () => {
    const before = world.requests().length;
    await saveKey(world.replacementKey);
    const text = await status("Not checked yet");
    expect(text).not.toContain("Key not accepted");
    expect(text).not.toContain("Ready to use");
    expect(world.requests()).toHaveLength(before);
    evidence.recordAssertionEvidence("Replacement resets only the credential verdict", `${text}; requests before=${before}, after=${world.requests().length}`, !text.includes("Key not accepted") && !text.includes("Ready to use") && world.requests().length === before);
    await user.screenshot();
  });

  await step("the replacement reaches the same native provider and returns a successful answer", async () => {
    await send("Reply with a short confirmation.");
    await user.see({ text: world.answer }, { timeoutMs: WITHIN });
    const requests = world.requests();
    expect(requests.some(value => value.status === 200 && value.credential === "replacement" && value.model === world.modelId)).toBe(true);
    expect(requests.some(value => value.credential === "unexpected")).toBe(false);
    evidence.recordAssertionEvidence("The successful answer used the replacement, not a fallback provider", JSON.stringify(requests), requests.some(value => value.status === 200 && value.credential === "replacement" && value.model === world.modelId) && requests.every(value => value.credential !== "unexpected"));
    await user.screenshot();
  });

  await step("after: only the successful request earns Ready to use", async () => {
    await user.navigate(world.settingsUrl);
    const text = await status("Ready to use");
    expect(text).not.toContain("Not checked yet");
    expect(text).not.toContain("Key not accepted");
    expect(text).not.toContain("Replace key");
    evidence.recordAssertionEvidence("The provider is ready after observed success and no longer offers a repair", text, !text.includes("Not checked yet") && !text.includes("Key not accepted") && !text.includes("Replace key"));
    await user.screenshot();
  });
});
