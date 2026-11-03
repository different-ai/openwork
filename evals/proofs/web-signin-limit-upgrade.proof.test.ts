import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { webSignInGate } from "../worlds/web-signin-limit-upgrade.ts";
import { workbotUsageRecovery } from "../worlds/workbot-usage-recovery.ts";

// The sign-in gate runs on the real Workbot, Den and runner.
const gate = spec.world(webSignInGate, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});
// The limit runs on the real Workbot UI, runner and model adapter against the gateway's exact 429s; only Den's
// recovery options are synthetic, because a local Den cannot be made to report a used-up free allowance.
// Standalone Workbot uses direct Chrome, not seed.web (the Den dashboard).
const limit = spec.world(workbotUsageRecovery, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: ["mock"] } });

gate("a visitor must sign in before Workbot shows any chat, then gets a first answer", async ({ world, user, probe, step, evidence }) => {
  await step("before signing in: the visitor lands on Den's Workbot sign-in, with no chat to type into", async () => {
    await user.navigate(world.url);
    await user.see({ testId: "workbot-sign-in-frame" }, { timeoutMs: 90_000 });
    await user.see({ role: "heading", label: "Sign in to Workbot" });
    await user.notSee({ role: "textbox", label: "Message Workbot" });
    const landed = new URL(await probe.url());
    const composers = await probe.dom('textarea[aria-label="Message Workbot"]');
    evidence.recordAssertionEvidence("A signed-out visitor is sent to Den's sign-in; no anonymous composer and no model use",
      `page origin=${landed.origin === world.url ? "Workbot" : "Den"}; composers=${composers.elements.length}; model completions=${world.completions()}`,
      landed.origin !== world.url && composers.elements.length === 0 && world.completions() === 0);
    expect(landed.origin).not.toBe(world.url);
    expect(composers.elements).toHaveLength(0);
    expect(world.completions()).toBe(0);
    await user.screenshot();
  });

  await step("Workbot's own API refuses the visitor too", async () => {
    await user.navigate(`${world.url}/v1/workbot/me`);
    const body = await probe.text();
    await user.notSee({ text: world.person.email });
    evidence.recordAssertionEvidence("Without a session Workbot answers no account and no conversation", body.slice(0, 120), !body.includes(world.person.email) && !body.includes("turns"));
    expect(body).not.toContain(world.person.email);
    expect(body).not.toContain("turns");
  });

  await step("the person signs in with Den and comes back to a ready Workbot composer", async () => {
    await user.navigate(world.url);
    await user.see({ role: "textbox", label: "Email" }, { timeoutMs: 60_000 });
    await user.type({ role: "textbox", label: "Email" }, world.person.email);
    await user.click({ role: "button", label: "Next" });
    await user.see({ role: "textbox", label: "Password" }, { timeoutMs: 30_000 });
    await user.type({ role: "textbox", label: "Password" }, world.person.password, { sensitive: true });
    await user.click({ role: "button", label: "Sign in" });
    // Den may ask which workspace, and Workbot greets a first visit (hello, then the team's apps) before its composer.
    const screen = async () => {
      const enabled = (await probe.dom("button:not(:disabled)")).elements.filter(button => button.rect.width > 0 && button.rect.height > 0).map(button => button.text.trim());
      const composer = (await probe.dom('textarea[aria-label="Message Workbot"]')).elements.length > 0;
      return { composer, choose: enabled.includes("Continue to Workbot"), hello: enabled.includes("Get started"), apps: enabled.includes("Start chatting") };
    };
    let arrival = await probe.eventually(screen, { within: 90_000, label: "Den returns the person to Workbot or asks for the workspace", until: value => value.composer || value.choose || value.hello || value.apps });
    if (arrival.choose) {
      await user.click({ role: "button", label: "Continue to Workbot" });
      arrival = await probe.eventually(screen, { within: 90_000, label: "Workbot opens after the workspace choice", until: value => value.composer || value.hello || value.apps });
    }
    if (arrival.hello && !arrival.apps) {
      await user.click({ role: "button", label: "Get started" });
      arrival = await probe.eventually(screen, { within: 30_000, label: "Workbot's hello moves on", until: value => value.composer || value.apps });
    }
    if (arrival.apps) await user.click({ role: "button", label: "Start chatting" });
    await user.see({ role: "textbox", label: "Message Workbot" }, { timeoutMs: 90_000 });
    const origin = new URL(await probe.url()).origin;
    evidence.recordAssertionEvidence("After signing in the person is back on Workbot with a composer", `page origin=${origin === world.url ? "Workbot" : origin}`, origin === world.url);
    expect(origin).toBe(world.url);
    await user.screenshot();
  });

  await step("after: the first message gets an answer", async () => {
    await user.type({ role: "textbox", label: "Message Workbot" }, "Hello Workbot, what can you do?");
    await user.click({ role: "button", label: "Send" });
    await user.see({ text: world.reply }, { timeoutMs: 120_000 });
    await user.notSee({ testId: "workbot-model-recovery" });
    const completions = world.completions();
    evidence.recordAssertionEvidence("The signed-in person's first message is answered by Workbot's model", `model completions=${completions}; answer shown`, completions >= 1);
    expect(completions).toBeGreaterThanOrEqual(1);
    await user.screenshot();
  });
});

limit("when the free allowance runs out, a billing admin can get OpenWork Models and a member is told to ask an admin", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

  await step("after: the billing admin's card says what ran out, when it resets and that the message is saved, with Get OpenWork Models first", async () => {
    await user.navigate(`${world.url}`);
    await user.see({ text: "You've used the free model allowance for now" });
    await user.see({ text: /^Resets / });
    await user.see({ text: "Your message is saved" });
    await user.see({ role: "link", label: /^Get OpenWork Models/ });
    await user.see({ role: "link", label: /^Change model/ });
    const models = await probe.dom('[data-testid="workbot-model-recovery"] a[href^="https://den.example.test/dashboard/ai-gateway?tab=openwork-models&workbotOrganizationId=org_recovery"][target="_blank"]');
    const order = (await probe.dom('[data-testid="workbot-model-recovery"] a')).elements.map(element => element.text.trim());
    const witness = world.witness("free");
    evidence.recordAssertionEvidence("The upgrade opens Den's OpenWork Models page for this workspace, first among the actions, after one refused request",
      `links=${order.join(" | ")}; model attempts=${witness.attempts}`, models.elements.length === 1 && order[0]?.startsWith("Get OpenWork Models") === true && witness.attempts === 1);
    expect(models.elements).toHaveLength(1);
    expect(order[0]).toMatch(/^Get OpenWork Models/);
    expect(witness).toEqual({ attempts: 1, retryable: false });
    await user.screenshot();
  });

  await step("a member sees who can buy instead of a purchase link", async () => {
    await user.navigate(`${world.url}?persona=member`);
    await user.see({ text: "You've used the free model allowance for now" });
    await user.see({ text: /^Ask an admin for OpenWork Models/ });
    await user.notSee({ role: "link", label: /^Get OpenWork Models/ });
    const links = await probe.dom('[data-testid="workbot-model-recovery"] a');
    const locked = await probe.dom('[data-testid="workbot-model-recovery-locked"]');
    evidence.recordAssertionEvidence("A member gets a visible, locked next step and no purchase or management link", `links=${links.elements.length}; locked=${locked.elements.length}`, links.elements.length === 0 && locked.elements.length === 1);
    expect(links.elements).toHaveLength(0);
    expect(locked.elements).toHaveLength(1);
    await user.screenshot();
  });

  await step("a used-up OpenWork Models allowance reads as the workspace's limit, once, never as an outage", async () => {
    await user.navigate(`${world.url}?issue=allowance&persona=member`);
    await user.see({ text: "Your workspace reached its model usage limit" });
    await user.see({ text: /^Ask an admin for more/ });
    await user.notSee({ text: "I couldn't reach the AI model just now." });
    await user.notSee({ role: "link", label: /^Get OpenWork Models/ });
    const witness = world.witness("allowance");
    evidence.recordAssertionEvidence("The gateway's allowance answer is classified and not retried", `model attempts=${witness.attempts}; automatic retry offered=${witness.retryable}`, witness.attempts === 1 && witness.retryable === false);
    expect(witness).toEqual({ attempts: 1, retryable: false });
    await user.screenshot();
  });
});
