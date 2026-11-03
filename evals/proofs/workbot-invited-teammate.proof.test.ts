import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotInvitedTeammate } from "../worlds/workbot-invited-teammate.ts";

const test = spec.world(workbotInvitedTeammate, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

test("a teammate invited before signing up joins their team from Workbot instead of creating a workspace", async ({ world, user, probe, step, evidence }) => {
  await step("before: the invited teammate signs up from Workbot and verifies their email", async () => {
    await user.navigate(world.url);
    await user.see({ testId: "workbot-sign-in-frame" }, { timeoutMs: 90_000 });
    await user.type({ role: "textbox", label: "Email" }, world.person.email);
    await user.click({ role: "button", label: "Next" });
    await user.type({ role: "textbox", label: "Name" }, world.person.name);
    await user.type({ role: "textbox", label: "Password" }, world.person.password, { sensitive: true });
    await user.click({ role: "button", label: "Sign up" });
    await user.see({ role: "textbox", label: "Verification code" }, { timeoutMs: 30_000 });
    const code = await probe.eventually(() => world.otp(), { within: 15_000, label: "the account's verification code exists", until: value => /^\d{6}$/.test(value ?? "") });
    await user.type({ role: "textbox", label: "Verification code" }, code ?? "");
    await user.click({ role: "button", label: "Verify email" });
    await user.screenshot();
  });

  await step("after: the workspace choice offers the invitation instead of asking for a new workspace name", async () => {
    await user.see({ role: "heading", label: "Choose a workspace" }, { timeoutMs: 60_000 });
    await user.see({ text: world.workspaceName });
    await user.see({ text: "Invited · Member" });
    await user.notSee({ role: "textbox", label: "Workspace name" });
    await user.see({ role: "button", label: "Create a new workspace instead" });
    evidence.recordAssertionEvidence("The invitation is offered first", `${world.workspaceName} listed as an invitation; no workspace-name field`, await probe.has("Invited · Member"));
    await user.screenshot();
  });

  await step("joining the invitation opens Workbot in the team's workspace", async () => {
    await user.click({ role: "button", label: "Continue to Workbot" });
    await probe.eventually(() => probe.url(), { within: 60_000, label: "the OAuth callback returns to Workbot", until: url => new URL(url).origin === world.url });
    await user.navigate(`${world.url}/v1/workbot/me`);
    const account: unknown = JSON.parse(await probe.text());
    expect(account).toMatchObject({ organizationName: world.workspaceName });
    expect(await world.workspaces()).toEqual([world.workspaceName]);
    evidence.recordAssertionEvidence("The teammate joined, not founded, a workspace", `memberships: ${(await world.workspaces()).join(", ")}`, (await world.workspaces()).length === 1);
    await user.navigate(world.url);
    await user.see({ role: "button", label: "Get started" }, { timeoutMs: 90_000 });
    await user.click({ role: "button", label: "Get started" });
    // The team's welcome: the apps Acme already connected come with the workspace.
    await user.see({ text: "Set up for you by your team." }, { timeoutMs: 30_000 });
    await user.screenshot();
    await user.click({ role: "button", label: "Start chatting" });
    await user.see({ role: "textbox", label: "Message Workbot" }, { timeoutMs: 90_000 });
    await user.screenshot();
  });
});
