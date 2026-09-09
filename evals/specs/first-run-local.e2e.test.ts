import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { localFirstRunWorld } from "../worlds/first-run.ts";

const test = spec.world(localFirstRunWorld);

test("first launch opens an empty signed-out workspace and runs the first prompt without onboarding", async ({ world, user, probe, step }) => {
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
