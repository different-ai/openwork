import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { optionalCloudTrial } from "../worlds/dashboards.ts";

// New journey: choose an optional no-card cloud trial and understand what
// happens when it ends. Runtime/access isolation remains in remote-session-first-use.
const test = spec.world(optionalCloudTrial, { timeout: 420_000 });
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected JSON object");
  return value;
}

test("an optional seven-day cloud trial explains model access, starts without a card, and ends without a subscription", async ({ world, user, probe, evidence, step }) => {
  const trial = async () => {
    const result = await probe.api(world.den.admin, "/v1/billing/web-trial");
    expect(result.response.status, result.text).toBe(200);
    return record(record(result.body).trial);
  };
  const billing = async () => {
    const result = await probe.api(world.den.admin, "/v1/billing/web");
    expect(result.response.status, result.text).toBe(200);
    return record(record(record(record(result.body).billing).stripe).web);
  };

  await step("the cloud offer is optional and separates models from cloud access", async () => {
    await user.see({ testId: "cloud-trial-card" }, { timeoutMs: 90_000 });
    await user.see({ text: "Try OpenWork Cloud for 7 days" });
    await user.see({ text: /No card required\..*You won’t be charged automatically\./ });
    await user.see({ text: /[Mm]odel.*separate/ });
    expect(await trial()).toMatchObject({ status: "eligible", startedAt: null, expiresAt: null });
    expect(await billing()).toMatchObject({ hasAccess: false, subscription: null });
    await user.hover({ testId: "cloud-trial-start" });
    await user.looks(["The optional cloud trial clearly offers seven days without a card or automatic charges, explains that model access is separate, and provides a way to skip"]);
    await user.click({ testId: "cloud-trial-dismiss" });
    await user.notSee({ testId: "cloud-trial-card" });
    expect(await trial()).toMatchObject({ status: "eligible", startedAt: null, expiresAt: null });
    expect(await billing()).toMatchObject({ hasAccess: false, subscription: null });
    evidence.recordAssertionEvidence("Reviewing and skipping the cloud offer does not start a trial or create a subscription", "The visible offer explained the no-card terms and separate model access; after Do this later, the real trial endpoint remained eligible with no dates and billing remained locked with no subscription.", true);
  });

  let started: Record<string, unknown>;
  await step("starting the trial shows its actual expiry without collecting payment", async () => {
    await user.navigate(new URL("/dashboard/web", world.den.ref.webUrl).toString());
    await user.see({ role: "button", label: "Start 7-day free trial" }, { timeoutMs: 90_000 });
    await user.click({ role: "button", label: "Start 7-day free trial" });
    await user.see({ text: "Your cloud trial is active" }, { timeoutMs: 30_000 });
    started = await trial();
    expect(started.status).toBe("active");
    if (typeof started.startedAt !== "string" || typeof started.expiresAt !== "string") throw new Error("Expected actual trial dates");
    expect(Date.parse(started.expiresAt) - Date.parse(started.startedAt)).toBe(7 * 24 * 60 * 60 * 1000);
    await user.see({ text: /Cloud access ends/ });
    expect(await probe.eval("document.querySelector('[data-testid=cloud-trial-card] time')?.getAttribute('datetime')")).toBe(started.expiresAt);
    await user.see({ role: "link", label: "Open OpenWork Web" });
    expect(await billing()).toMatchObject({ hasAccess: true, subscription: null });
    await user.hover({ testId: "cloud-trial-card" });
    await user.looks(["The active trial shows when cloud access ends and a clear Open OpenWork Web action, without implying model credits or a paid subscription"]);
    await user.reload();
    await user.see({ text: "Your cloud trial is active" }, { timeoutMs: 90_000 });
    expect(await trial()).toEqual(started);
    evidence.recordAssertionEvidence("The visible start action creates one seven-day trial that survives reload without a paid subscription", JSON.stringify({ started, hasAccess: true, subscription: null }), true);
  });

  await step("the owner receives a clear reminder before cloud access pauses", async () => {
    await world.ageTrial("ending");
    await probe.eventually(async () => {
      const result = await probe.api(world.den.admin, "/v1/dev/emails?template=cloudTrial");
      const entries = record(result.body).emails;
      if (!Array.isArray(entries)) throw new Error("Expected trial notification outbox");
      return entries.map(record).some((entry) => entry.subject === "Your OpenWork cloud trial ends soon" && entry.to === world.den.admin.email);
    }, { within: 30_000, label: "owner receives the final-day reminder", until: Boolean });
    await user.navigate(new URL("/v1/dev/emails/last?template=cloudTrial", world.den.ref.apiUrl).toString());
    await user.see({ role: "heading", label: "Your OpenWork cloud trial ends soon" });
    await user.see({ text: /No payment will be taken/ });
    await user.looks(["The actual trial reminder email has a readable monochrome OpenWork design, explains when cloud access pauses, reassures that saved work remains, and makes any paid upgrade optional"]);
    await user.navigate(new URL("/dashboard/web", world.den.ref.webUrl).toString());
    await user.see({ text: "Your cloud trial ends soon" });
    expect(await billing()).toMatchObject({ hasAccess: true, subscription: null });
    evidence.recordAssertionEvidence("The owner is notified before expiry while cloud access remains available", "The persisted trial entered its final day; the real notification worker sent the owner an email and Web still reported active access without a subscription.", true);
  });

  await step("expiry explains the next choice and leaves paid access opt-in", async () => {
    await world.ageTrial("expired");
    await user.reload();
    await user.see({ text: "Your cloud trial has ended" }, { timeoutMs: 90_000 });
    await user.see({ role: "link", label: "View paid plan" });
    await user.notSee({ role: "button", label: "Start 7-day free trial" });
    expect(await trial()).toMatchObject({ status: "expired" });
    expect(await billing()).toMatchObject({ hasAccess: false, subscription: null });
    const emails = await probe.eventually(async () => {
      const result = await probe.api(world.den.admin, "/v1/dev/emails?template=cloudTrial");
      expect(result.response.status, result.text).toBe(200);
      const entries = record(result.body).emails;
      if (!Array.isArray(entries)) throw new Error("Expected trial notification outbox");
      return entries.map(record);
    }, { within: 30_000, label: "the expired notification reaches the trial owner", until: (entries) => entries.some((entry) => entry.subject === "Your OpenWork cloud trial has ended") });
    expect(emails.filter((entry) => entry.subject === "Your OpenWork cloud trial has ended").map((entry) => entry.to)).toEqual([world.den.admin.email]);
    await user.hover({ testId: "cloud-trial-card" });
    await user.looks(["The expired trial explains that cloud access has ended and that upgrading is an explicit choice, with no automatic charge and retained work explained"]);
    await user.navigate(new URL("/v1/dev/emails/last?template=cloudTrial", world.den.ref.apiUrl).toString());
    await user.see({ role: "heading", label: "Your OpenWork cloud trial has ended" });
    await user.see({ text: /No payment will be taken/ });
    await user.looks(["The actual expired-trial email clearly says cloud access has paused, saved work is retained, no payment is taken automatically, and offers a calm way to review cloud access"]);
    await user.click({ role: "link", label: "Review cloud access" });
    await user.see({ text: "Your cloud trial has ended" }, { timeoutMs: 90_000 });
    await user.notSee({ role: "button", label: "Start 7-day free trial" });
    await user.click({ role: "link", label: "View paid plan" });
    expect(await probe.eval("window.location.pathname")).toBe("/dashboard/web");
    expect(await billing()).toMatchObject({ hasAccess: false, subscription: null });
    evidence.recordAssertionEvidence("Trial expiry appears in the app and sends its owner a notification while access stops and no subscription is created", "The real persisted trial expired; the screen offered View paid plan, the development outbox captured its owner notification, and billing stayed locked with subscription null after viewing the plan.", true);
  });
});
