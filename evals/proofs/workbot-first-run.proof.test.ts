import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotFirstRun } from "../worlds/workbot-first-run.ts";

const test = spec.world(workbotFirstRun, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

test("a new person verifies their email, creates a workspace and returns directly to Workbot", async ({ world, user, probe, step, evidence }) => {
  await step("before: Workbot asks the new person to sign in, not to manage an organization", async () => {
    await user.navigate(world.url);
    await user.see({ testId: "workbot-sign-in-frame" }, { timeoutMs: 90_000 });
    await user.see({ role: "heading", label: "Sign in to Workbot" });
    await user.notSee({ text: /\/ Cloud/ });
    await user.notSee({ testId: "setup-story-tiles" });
    evidence.recordAssertionEvidence("The sign-in belongs to Workbot", "One compact Workbot sign-in panel; no Cloud dashboard or agent-consent story", (await probe.dom('[data-testid="workbot-sign-in-frame"]')).elements.length === 1);
    await user.screenshot();
  });
  await step("the person creates an account and verifies the emailed code", async () => {
    await user.type({ role: "textbox", label: "Email" }, world.person.email);
    await user.click({ role: "button", label: "Next" });
    await user.type({ role: "textbox", label: "Name" }, world.person.name);
    await user.type({ role: "textbox", label: "Password" }, world.person.password, { sensitive: true });
    await user.click({ role: "button", label: "Sign up" });
    await user.see({ role: "textbox", label: "Verification code" }, { timeoutMs: 30_000 });
    const code = await probe.eventually(() => world.otp(), { within: 15_000, label: "the account's verification code exists", until: value => /^\d{6}$/.test(value ?? "") });
    await user.type({ role: "textbox", label: "Verification code" }, code ?? "");
    await user.click({ role: "button", label: "Verify email" });
    await user.see({ role: "textbox", label: "Workspace name" }, { timeoutMs: 60_000 });
    expect(await probe.url()).toContain("/mcp/select-organization?");
    evidence.recordAssertionEvidence("Verification resumes the original Workbot sign-in", "The new verified account reaches workspace creation on the signed OAuth query", (await probe.url()).includes("client_id=openwork-workbot"));
    await user.screenshot();
  });
  await step("after: naming a workspace opens Workbot with a ready conversation", async () => {
    await user.type({ role: "textbox", label: "Workspace name" }, world.workspaceName);
    await user.notSee({ text: "Requested access" });
    await user.screenshot();
    await user.click({ role: "button", label: "Create workspace and open Workbot" });
    await probe.eventually(() => probe.url(), { within: 60_000, label: "the OAuth callback returns to Workbot", until: url => new URL(url).origin === world.url && new URL(url).pathname === "/" });
    await user.navigate(`${world.url}/v1/workbot/me`);
    const account: unknown = JSON.parse(await probe.text());
    expect(account).toMatchObject({ organizationName: world.workspaceName, enabled: true });
    await user.navigate(world.url);
    const arrival = await probe.eventually(async () => ({
      ready: (await probe.dom('textarea[aria-label="Message Workbot"]')).elements.length > 0,
      welcome: await probe.has("Get started"),
    }), { within: 30_000, label: "Workbot opens the conversation or its optional welcome", until: value => value.ready || value.welcome });
    if (arrival.welcome) await user.click({ role: "button", label: "Get started" });
    await user.see({ role: "textbox", label: "Message Workbot" }, { timeoutMs: 90_000 });
    await user.notSee({ testId: "workbot-workspace-access" });
    expect(new URL(await probe.url()).origin).toBe(world.url);
    evidence.recordAssertionEvidence("The workspace opens in Workbot, not the dashboard", "Workbot has a usable message composer after its real OAuth callback", new URL(await probe.url()).origin === world.url);
    await user.screenshot();
  });
  await step("the returning person chooses the same workspace without authorizing a third-party app", async () => {
    await user.navigate(`${world.url}/auth/login?workspace=choose`);
    await user.see({ role: "heading", label: "Choose a workspace" }, { timeoutMs: 60_000 });
    await user.see({ text: world.workspaceName });
    await user.notSee({ text: "Requested access" });
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const layout = await probe.dom('[data-testid="workbot-sign-in-frame"]');
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    evidence.recordAssertionEvidence("Workspace choice fits a phone viewport", `Document width ${layout.documentWidth}; viewport ${layout.viewportWidth}`, layout.documentWidth <= layout.viewportWidth);
    await user.screenshot();
    await user.click({ role: "button", label: "Continue to Workbot" });
    await user.see({ role: "textbox", label: "Message Workbot" }, { timeoutMs: 60_000 });
  });
});
