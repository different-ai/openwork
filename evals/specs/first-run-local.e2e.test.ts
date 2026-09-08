import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { installationFirstRunWorld, localFirstRunWorld } from "../worlds/first-run.ts";

const test = spec.world(localFirstRunWorld);

test("an existing empty profile keeps optional sign-in and its free starter default", async ({ world, user, probe, step }) => {
  await step("Start directly in the normal empty app", async () => {
    await user.see({ text: /What do you need done\?/ }, { timeoutMs: 180_000 });
    await user.see("composer", { editable: true, text: "" });
    await user.see("Run task");
    await user.see({ testId: "account-status-menu" }, { text: /Sign in/ });
    await user.notSee({ text: "Welcome to OpenWork" });
    await user.notSee("Use Without Cloud");
    await user.notSee({ text: /Choose (a )?folder|Choose (a )?model/ });
    await user.notSee({ text: "Power your first task" });
    await user.notSee({ text: "How did you hear about OpenWork?" });
    await user.notSee({ text: /Something went wrong/ });
    expect(await probe.storage("openwork.den.authToken")).toBeNull();
    expect(await probe.storage("openwork.den.activeOrgId")).toBeNull();
  });

  const composer = await probe.composer();
  const workspaceId = /^#\/workspace\/([^/]+)\/session$/.exec(composer.route)?.[1];
  if (!workspaceId) throw new Error(`Expected the empty workspace route, received ${composer.route}`);

  await step("The default folder is provisioned without creating a blank session", async () => {
    expect(composer.userMessageCount).toBe(0);
    expect(composer.assistantMessageCount).toBe(0);
    expect(composer.runTaskVisible).toBe(true);
    const workspaces = await probe.desktopApi("/workspaces");
    expect(workspaces.status).toBe(200);
    expect(workspaces.body).toMatchObject({
      activeId: workspaceId,
      items: [{ id: workspaceId, workspaceType: "local", path: expect.stringMatching(/[/\\]OpenWork Chat$/) }],
    });
    const sessions = await probe.desktopApi(`/workspace/${workspaceId}/opencode/session`);
    expect(sessions.status).toBe(200);
    expect(sessions.body).toEqual([]);
    await user.see({ text: /Using the free starter model/ });
    expect(await probe.storage("openwork.defaultModel")).toBe("opencode/big-pickle");
  });

  await step("The first prompt runs on the default provider without setup", async () => {
    await user.type("composer", world.prompt);
    await probe.eventually(async () => (await probe.composer()).runTaskEnabled, {
      within: 30_000,
      label: "first task ready without choosing a model",
      until: (enabled) => enabled,
    });
    expect(await probe.hash()).toBe(composer.route);
    expect(await world.mock.agentRequests({ promptMarker: world.prompt })).toEqual([]);
    await user.click("Run task");
    await user.see({ text: world.prompt }, { timeoutMs: 30_000 });
    await user.see({ text: world.reply }, { timeoutMs: 180_000 });
    const requests = await world.mock.agentRequests({ promptMarker: world.prompt, atLeast: 1, timeoutMs: 10_000 });
    expect(requests.some((request) => request.kind === "final" && request.model === "big-pickle")).toBe(true);
    expect((await probe.composer()).assistantMessageCount).toBeGreaterThan(0);
    await user.notSee({ text: "The free starter model is busy right now" });
    await user.notSee({ text: /subscribe to Go/i });
    await user.notSee({ text: /Error from provider/ });
    await user.notSee({ text: /Something went wrong/ });
    await user.notSee({ text: "Power your first task" });
    await user.notSee({ text: "How did you hear about OpenWork?" });
  });
});

const fresh = spec.world(installationFirstRunWorld);

// This exercises optional public sign-in with a mock-backed explicit provider,
// not native free Luna. Its gateway/allowance/version runtime journey is deferred.
// Explicit Enterprise bootstrap requireSignin remains a separate enforced policy.
fresh("a new public profile runs an explicitly selected fixture model while signed out and preserves it across restart", async ({ world, user, probe, step }) => {
  await step("The fresh signed-out profile opens the normal composer without a mandatory gate", async () => {
    expect(await world.bootstrap()).toEqual({ requireSignin: false, installationRequiresSignin: false });
    await user.see("composer", { editable: true, text: "", timeoutMs: 180_000 });
    await user.see("Run task");
    await user.see({ testId: "account-status-menu" }, { text: /Sign in/ });
    await user.notSee({ role: "button", text: "Sign in to OpenWork" });
    await user.notSee("Use Without Cloud");
    expect(await probe.storage("openwork.den.authToken")).toBeNull();
    expect(await probe.storage("openwork.den.activeOrgId")).toBeNull();
    expect(await world.mock.agentRequests()).toEqual([]);
  });

  const composer = await probe.composer();
  const workspaceId = /^#\/workspace\/([^/]+)\/session$/.exec(composer.route)?.[1];
  if (!workspaceId) throw new Error(`Expected the empty workspace route, received ${composer.route}`);

  await step("The default local workspace is prepared without creating a blank task", async () => {
    const workspaces = await probe.desktopApi("/workspaces");
    expect(workspaces.status).toBe(200);
    expect(workspaces.body).toMatchObject({
      activeId: workspaceId,
      items: [{ id: workspaceId, workspaceType: "local", path: expect.stringMatching(/[/\\]OpenWork Chat$/) }],
    });
    const sessions = await probe.desktopApi(`/workspace/${workspaceId}/opencode/session`);
    expect(sessions.status).toBe(200);
    expect(sessions.body).toEqual([]);
    expect(composer.userMessageCount).toBe(0);
    expect(composer.assistantMessageCount).toBe(0);
  });

  await step("An explicit OpenCode fixture selection runs without signing in", async () => {
    await user.click("Change model");
    await user.click({ testId: "model-option-opencode-big-pickle" });
    expect(await probe.storage("openwork.modelChoice.explicit")).toBe("1");
    expect(await probe.storage("openwork.defaultModel")).toBe("opencode/big-pickle");
    await user.type("composer", world.prompt);
    await probe.eventually(async () => (await probe.composer()).runTaskEnabled, {
      within: 30_000, label: "signed-out fixture task ready", until: (ready) => ready,
    });
    expect(await world.mock.agentRequests({ promptMarker: world.prompt })).toEqual([]);
    await user.click("Run task");
    await user.see({ text: world.reply }, { timeoutMs: 180_000 });
    const requests = await world.mock.agentRequests({ promptMarker: world.prompt, atLeast: 1 });
    expect(requests.some((request) => request.kind === "final" && request.model === "big-pickle")).toBe(true);
    expect(await probe.storage("openwork.den.authToken")).toBeNull();
    await user.notSee({ text: /Error from provider|Something went wrong/ });
  });

  const route = await probe.hash();
  expect(route).toMatch(new RegExp(`^#/workspace/${workspaceId}/session/[^/]+$`));
  const completedReplies = (await world.mock.agentRequests({ promptMarker: world.prompt })).filter((request) => request.kind === "final").length;
  await step("Signed-out restart restores the selected workspace, conversation, and explicit model without resubmitting", async () => {
    const restarted = await world.relaunch();
    await user.on(restarted).see("composer", { editable: true, timeoutMs: 180_000 });
    await user.on(restarted).see({ text: world.reply }, { timeoutMs: 60_000 });
    await user.on(restarted).see({ testId: "account-status-menu" }, { text: /Sign in/ });
    await user.on(restarted).notSee({ role: "button", text: "Sign in to OpenWork" });
    expect(await probe.on(restarted).hash()).toBe(route);
    expect(await probe.on(restarted).storage("openwork.defaultModel")).toBe("opencode/big-pickle");
    expect(await probe.on(restarted).storage("openwork.modelChoice.explicit")).toBe("1");
    expect(await probe.on(restarted).storage("openwork.den.authToken")).toBeNull();
    expect(await probe.on(restarted).storage("openwork.den.activeOrgId")).toBeNull();
    expect(await world.bootstrap()).toEqual({ requireSignin: false, installationRequiresSignin: false });
    expect((await probe.on(restarted).desktopApi("/workspaces")).body).toMatchObject({ activeId: workspaceId });
    expect((await world.mock.agentRequests({ promptMarker: world.prompt })).filter((request) => request.kind === "final").length).toBe(completedReplies);
  });
});

for (const cohort of ["legacy-empty", "legacy-populated"] as const) {
  const legacy = spec.world((seed, context) => installationFirstRunWorld(seed, context, cohort));
  legacy(`${cohort} keeps its workspace registry and optional sign-in after restart`, async ({ world, user, probe, step }) => {
    await step("Existing profile state is not mistaken for a new installation", async () => {
      expect(await world.bootstrap()).toEqual({ requireSignin: false, installationRequiresSignin: false });
      await user.see("composer", { editable: true, timeoutMs: 180_000 });
      expect(await probe.storage("openwork.den.authToken")).toBeNull();
      const listed = await probe.desktopApi("/workspaces");
      expect(listed.status).toBe(200);
      if (cohort === "legacy-empty") expect(listed.body).toMatchObject({ items: [] });
      else expect(listed.body).toMatchObject({ items: [expect.objectContaining({ path: expect.stringMatching(/[/\\]existing-workspace$/) })] });
    });
    await step("The legacy default and optional access survive relaunch", async () => {
      const defaultModel = await probe.storage("openwork.defaultModel");
      const restarted = await world.relaunch();
      await user.on(restarted).see("composer", { editable: true, timeoutMs: 180_000 });
      expect(await probe.on(restarted).storage("openwork.defaultModel")).toBe(defaultModel);
      expect(await world.bootstrap()).toEqual({ requireSignin: false, installationRequiresSignin: false });
    });
  });
}
