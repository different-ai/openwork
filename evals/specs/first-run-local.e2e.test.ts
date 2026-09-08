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

fresh("a new installation requires verified sign-in for UI and automated tasks across logout and restart", async ({ world, user, agent, probe, step }) => {
  await step("A genuinely fresh signed-out profile makes zero generation calls", async () => {
    expect(await world.bootstrap()).toEqual({ requireSignin: false, installationRequiresSignin: true });
    await user.see({ role: "button", text: "Sign in to OpenWork" });
    await user.notSee("composer");
    await user.notSee("Use Without Cloud");
    await user.notSee("Run task");
    expect(await probe.storage("openwork.den.authToken")).toBeNull();
    await agent.run("route.session");
    await user.notSee("composer");
    await expect(agent.run("session.create_task", { prompt: world.prompt })).rejects.toThrow("Unknown action: session.create_task");
    const attempt = await agent.desktopApi("/opencode/session", { method: "POST", body: { title: "Blocked task" } });
    expect(attempt).toMatchObject({ status: 403, body: { code: "signin_required" } });
    expect(await world.mock.agentRequests()).toEqual([]);
  });

  const { grant, proxy } = world;
  if (!grant || !proxy) throw new Error("Fresh installation requires its isolated Den grant and fault proxy.");
  await step("A successful handoff unlocks the prepared empty workspace", async () => {
    await agent.run("auth.exchange-grant", { grant, baseUrl: proxy.ref.webUrl });
    await user.see("composer", { editable: true, text: "", timeoutMs: 180_000 });
    await user.type("composer", world.prompt);
    await probe.eventually(async () => (await probe.composer()).runTaskEnabled, {
      within: 30_000, label: "verified first task ready", until: (ready) => ready,
    });
    await user.click("Run task");
    await user.see({ text: world.reply }, { timeoutMs: 180_000 });
    expect((await world.mock.agentRequests({ promptMarker: world.prompt, atLeast: 1 })).length).toBeGreaterThan(0);
    expect(await world.bootstrap()).toEqual({ requireSignin: false, installationRequiresSignin: true });
  });

  const completedRequests = (await world.mock.agentRequests()).length;
  const route = await probe.hash();
  const match = /^#\/workspace\/([^/]+)\/session\/([^/]+)$/.exec(route);
  if (!match) throw new Error(`Expected a completed task route: ${route}`);
  const [, workspaceId, sessionId] = match;
  const prompt = { parts: [{ type: "text", text: world.prompt }], model: { providerID: "opencode", modelID: "big-pickle" } };

  await step("Offline restart retains the token but cannot run work until verified", async () => {
    const token = await probe.storage("openwork.den.authToken");
    await proxy.faults.status("/api/den/v1/me", 503, { times: 100 });
    const restarted = await world.relaunch();
    await user.on(restarted).see({ role: "button", text: "Sign in to OpenWork" }, { timeoutMs: 60_000 });
    await user.on(restarted).notSee("composer");
    expect(await probe.on(restarted).storage("openwork.den.authToken")).toBe(token);
    expect(await agent.on(restarted).desktopApi(`/workspace/${workspaceId}/opencode/session/${sessionId}/prompt_async`, { method: "POST", body: prompt }))
      .toMatchObject({ status: 403, body: { code: "signin_required" } });
    expect((await world.mock.agentRequests()).length).toBe(completedRequests);
    await world.resetAuthFaults();
    await user.on(restarted).click("Refresh");
    await user.on(restarted).see("composer", { editable: true, timeoutMs: 90_000 });
    for (const code of ["session_expired", "session_revoked"]) {
      await step(`${code} blocks admission immediately and relocks the idle renderer`, async () => {
        await proxy.faults.status("/api/den/v1/me", 401, { times: 100, body: { error: "unauthorized" } });
        expect(await agent.on(restarted).desktopApi(`/workspace/${workspaceId}/opencode/session/${sessionId}/prompt_async`, { method: "POST", body: prompt }))
          .toMatchObject({ status: 403, body: { code: "signin_required" } });
        await user.on(restarted).see({ role: "button", text: "Sign in to OpenWork" }, { timeoutMs: 45_000 });
        expect(await probe.on(restarted).storage("openwork.den.authToken")).toBeNull();
        expect((await world.mock.agentRequests()).length).toBe(completedRequests);
        await world.resetAuthFaults();
        await agent.on(restarted).run("auth.exchange-grant", { grant: await world.issueGrant(), baseUrl: proxy.ref.webUrl });
        await user.on(restarted).see("composer", { editable: true, timeoutMs: 90_000 });
      });
    }
    await user.on(restarted).click({ testId: "account-status-menu" });
    await user.on(restarted).click("Sign out");
    await user.on(restarted).see({ role: "button", text: "Sign in to OpenWork" }, { timeoutMs: 30_000 });
    await user.on(restarted).notSee("Use Without Cloud");
    await user.on(restarted).notSee("composer");
    expect(await probe.on(restarted).storage("openwork.den.authToken")).toBeNull();
    for (const path of [
      `/workspace/${workspaceId}/opencode/session/${sessionId}/prompt_async`,
      `/workspace/${workspaceId}/opencode2/session/${sessionId}/message`,
      `/w/${workspaceId}/opencode/session/${sessionId}/command`,
      `/opencode/session/${sessionId}/summarize`,
    ]) {
      expect(await agent.on(restarted).desktopApi(path, { method: "POST", body: prompt }))
        .toMatchObject({ status: 403, body: { code: "signin_required" } });
    }
  });

  await step("Signed-out restart remains locked and does not generate", async () => {
    const restarted = await world.relaunch();
    await user.on(restarted).see({ role: "button", text: "Sign in to OpenWork" });
    await user.on(restarted).notSee("composer");
    expect(await world.bootstrap()).toEqual({ requireSignin: false, installationRequiresSignin: true });
    expect(await agent.on(restarted).desktopApi("/opencode/session", { method: "POST", body: {} }))
      .toMatchObject({ status: 403, body: { code: "signin_required" } });
    expect((await world.mock.agentRequests()).length).toBe(completedRequests);
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
