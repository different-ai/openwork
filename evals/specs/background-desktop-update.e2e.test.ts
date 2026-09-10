import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { backgroundUpdateWorld, revokedUpdateWorld } from "../worlds/first-run.ts";
import { restartUpdateTaskWorld } from "../worlds/chat.ts";

const test = spec.world(backgroundUpdateWorld);
const revokedTest = spec.world(revokedUpdateWorld);

revokedTest("a downloaded update is not installed once the organization revokes its version", async ({ world, user, probe }) => {
  const readyText = "Ready to install: v9.9.9";
  const blockedText = "OpenWork 9.9.9 is available, but this installation is not eligible for it yet.";
  const downloaded = (count: number) => (value: unknown) =>
    typeof value === "object" && value !== null && Reflect.get(value, "downloads") === count;

  await world.openSettings();
  await user.click({ role: "button", text: "Check now" });
  await probe.eventually(world.snapshot, { within: 30_000, label: "the allowed version downloads", until: downloaded(1) });
  await user.see({ text: readyText });
  await user.see({ text: "Restart to update" });

  // Negative half: the organization drops 9.9.9 after the download completed.
  await world.allowVersions(["0.18.0"]);
  await user.click("Restart to update");
  await user.see({ text: "Restart OpenWork?" });
  await user.click("Restart & update");
  await user.see({ text: blockedText }, { timeoutMs: 30_000 });
  await user.notSee({ text: readyText });
  await user.notSee({ text: "Restart to update" });
  await user.notSee({ text: "Install & restart" });
  expect(await world.snapshot()).toMatchObject({ downloads: 1, installs: 0 });
  await user.screenshot();

  // Positive control: the same version approved again installs from Settings.
  await world.allowVersions(["9.9.9"]);
  await user.click({ role: "button", text: "Check now" });
  await probe.eventually(world.snapshot, { within: 30_000, label: "the re-approved version downloads again", until: downloaded(2) });
  await user.see({ text: readyText });
  await user.notSee({ text: blockedText });
  await user.click({ role: "button", text: "Install & restart" });
  await probe.eventually(world.snapshot, {
    within: 10_000, label: "install proceeds while the version stays allowed",
    until: (value) => typeof value === "object" && value !== null && Reflect.get(value, "installs") === 1,
  });
  expect(await world.snapshot()).toMatchObject({ downloads: 2, installs: 1 });
});

test("updates download outside Settings and offer a persistent, optional restart", async ({ world, user, probe }) => {
  await probe.eventually(world.snapshot, {
    within: 15_000, label: "initial background check finds no update",
    until: (value) => typeof value === "object" && value !== null && Reflect.get(value, "checks") === 2,
  });
  expect(await world.snapshot()).toMatchObject({ checks: 2, downloads: 0 });
  await world.returnToApp();
  await probe.eventually(world.snapshot, {
    within: 5_000, label: "return after the interval checks again while idle",
    until: (value) => typeof value === "object" && value !== null && Reflect.get(value, "checks") === 3,
  });
  await world.tickUpdateInterval();
  await probe.eventually(world.snapshot, {
    within: 15_000, label: "background download without opening Settings",
    until: (value) => typeof value === "object" && value !== null && Reflect.get(value, "downloads") === 1,
  });
  expect(await world.snapshot()).toMatchObject({ checks: 4, downloads: 1, installs: 0, sidebarName: "OpenWork" });
  await user.notSee({ text: "Restart to update" });
  await world.returnToApp();
  expect(await world.snapshot()).toMatchObject({ checks: 4, downloads: 1, installs: 0 });
  for (const [index, message] of [
    "Update native preparation failed.",
    "Update download connection failed.",
  ].entries()) {
    await world.finishDownload();
    await user.click({ role: "button", label: /^Notifications/ });
    await user.see({ text: message });
    await user.press("Escape");
    await user.notSee({ text: "Restart to update" });
    expect(await world.snapshot()).toMatchObject({ downloads: index + 1, installs: 0, installAttempts: 0 });
    await world.openSettings();
    await user.click({ role: "button", text: "Check now" });
    await probe.eventually(world.snapshot, {
      within: 5_000, label: "the user retries the failed download through Settings",
      until: (value) => typeof value === "object" && value !== null && Reflect.get(value, "downloads") === index + 2,
    });
    await world.openWorkspace();
    await user.notSee({ text: "Restart to update" });
  }
  await world.finishDownload();
  await user.see({ text: "Restart to update" });
  await user.notSee({ text: "Ready when you are." });
  await world.openSettings();
  await user.see({ text: "Restart to update" });
  await world.openWorkspace();
  await world.returnToApp();
  await user.see({ text: "Restart to update" });
  expect(await world.snapshot()).toMatchObject({ checks: 6, downloads: 3, installs: 0, installAttempts: 0, updateInTitlebar: true, updateInSidebar: false });
  await user.looks([
    "A compact neutral Restart to update button sits in the titlebar with the app's other controls",
    "The OpenWork name remains above the sidebar navigation and no update card or banner covers the workspace",
  ]);
  await user.click("Restart to update");
  await user.notSee({ text: "Ready when you are." });
  await user.see({ text: "Restart OpenWork?" });
  await user.see({ text: /Eligible running tasks resume gradually after restart/ });
  await user.click("Keep working");
  await probe.eventually(async () => {
    await user.notSee({ text: "Restart OpenWork?" }, { timeoutMs: 100 });
    return true;
  }, { within: 5_000, label: "Keep working dismisses the restart dialog", until: Boolean });
  expect(await world.snapshot()).toMatchObject({ installs: 0, installAttempts: 0 });

  // The background behavior above is proven. Isolate the manual install-error
  // retries below from another background check after a fresh policy arrives.
  await world.openSettings();
  await user.click({ label: "Check automatically" });
  await world.openWorkspace();
  await world.setCustomBranding();
  await probe.eventually(world.snapshot, {
    within: 5_000, label: "custom logo is preserved instead of the default wordmark",
    until: (value) => typeof value === "object" && value !== null && Reflect.get(value, "customLogoLoaded") === true,
  });
  expect(await world.snapshot()).toMatchObject({ sidebarName: null, customLogoLoaded: true });
  for (const [index, message] of [
    "Update installer could not start.",
    "Update installer connection failed.",
  ].entries()) {
    await user.click("Restart to update");
    await user.see({ text: "Restart Studio?" });
    expect(await world.snapshot()).toMatchObject({ installAttempts: index, installs: 0 });
    await user.click("Restart & update");
    await user.click({ role: "button", label: /^Notifications/ });
    await user.see({ text: message });
    await user.press("Escape");
    await probe.eventually(async () => {
      await user.notSee({ text: "Restart Studio?" }, { timeoutMs: 100 });
      return true;
    }, { within: 5_000, label: "the failed restart dismisses its dialog", until: Boolean });
    await user.notSee({ text: "Restart to update" });
    expect(await world.snapshot()).toMatchObject({ installAttempts: index + 1, installs: 0 });
    await world.openSettings();
    await user.click({ role: "button", text: "Check now" });
    await probe.eventually(world.snapshot, {
      within: 5_000, label: "the user re-downloads after the failed install through Settings",
      until: (value) => typeof value === "object" && value !== null && Reflect.get(value, "downloads") === index + 4,
    });
    await user.notSee({ text: "Restart to update" });
    await world.finishDownload();
    await world.openWorkspace();
    await user.see({ text: "Restart to update" });
    expect(await world.snapshot()).toMatchObject({ installAttempts: index + 1, installs: 0 });
  }
  await user.click("Restart to update");
  await user.see({ text: "Restart Studio?" });
  expect(await world.snapshot()).toMatchObject({ installAttempts: 2, installs: 0 });
  await user.click("Restart & update");
  await probe.eventually(world.snapshot, {
    within: 5_000, label: "restart only after confirmation",
    until: (value) => typeof value === "object" && value !== null && Reflect.get(value, "installs") === 1,
  });
  expect(await world.snapshot()).toMatchObject({ installAttempts: 3, installs: 1 });
});

const recoveryTest = spec.world(restartUpdateTaskWorld, { timeout: 600_000 });

recoveryTest("a confirmed update relaunch resumes only the unfinished task on its original engine", async ({ world, user, agent, probe, step }) => {
  user = user.on(world.app);
  agent = agent.on(world.app);
  probe = probe.on(world.app);
  const v2 = world.engine === "v2";
  const mount = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/${v2 ? "opencode2/api" : "opencode"}`;
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an engine record");
    return Object.fromEntries(Object.entries(value));
  };
  const read = async (path: string): Promise<unknown> => {
    const response = await probe.desktopApi(`${mount}${path}`);
    expect(response.status).toBe(200);
    return v2 ? record(response.body).data : response.body;
  };
  const messages = async (sessionId: string) => {
    const value = await read(`/session/${sessionId}/${v2 ? "context" : "message?limit=100"}`);
    if (!Array.isArray(value)) throw new Error("Expected engine messages");
    return value.map((entry: unknown) => {
      const message = record(entry);
      const info = v2 ? message : record(message.info);
      const parts = v2 ? message.content : message.parts;
      if (!Array.isArray(parts)) throw new Error("Expected message parts");
      return { id: info.id, role: info[v2 ? "type" : "role"], parts: parts.map(record) };
    });
  };
  const open = async (session: { sessionId: string; title: string }) => {
    await user.click({ text: session.title });
    await probe.eventually(() => probe.hash(), { within: 30_000, label: "the intended task is selected",
      until: (hash) => hash.includes(`/session/${session.sessionId}`) });
  };
  const send = async (text: string) => { await user.type("composer", text, { verify: true }); await user.press("Enter"); };
  const active = async (id: string) => {
    const statuses = record(await read(v2 ? "/session/active" : "/session/status"));
    const status = statuses[id];
    return status !== undefined && ["running", "busy", "retry"].includes(String(record(status).type));
  };

  await step("one task completes and another is explicitly stopped", async () => {
    await send(world.completed.prompt);
    await user.see({ text: world.completed.reply }, { timeoutMs: 45_000 });
    await open(world.stopped);
    await send(world.stopped.prompt);
    await probe.eventually(() => active(world.stopped.sessionId), { within: 30_000, label: "the task is running before Stop", until: Boolean });
    await user.click({ role: "button", label: "Stop" });
    await probe.eventually(() => active(world.stopped.sessionId), { within: 30_000, label: "Stop settles its original run", until: (value) => !value });
  });
  const completedBefore = await messages(world.completed.sessionId);
  const stoppedBefore = await messages(world.stopped.sessionId);

  await step("an eligible task is executing when update is confirmed", async () => {
    await open(world.active);
    await send(world.active.prompt);
    await probe.eventually(async () => ({ active: await active(world.active.sessionId), messages: await messages(world.active.sessionId) }), {
      within: 30_000, label: "the original engine is running the unfinished tool",
      until: (state) => state.active && state.messages.some((message) => message.parts.some((part) => part.type === "tool" && record(part.state).status === "running")),
    });
    // Settings' existing Check for updates action consumes the arranged release
    // feed. Do not manipulate recovery state or inject a continuation here.
    await agent.run("settings.panel.open", { panel: "updates" });
    await user.click({ role: "button", text: "Check now" });
    await user.see({ text: "Restart to update" }, { timeoutMs: 30_000 });
    await user.click({ text: "Restart to update" });
    await user.see({ text: "Restart OpenWork?" });
    await user.click("Restart & update");
  });
  await step("a new renderer continues once without touching stopped or completed work", async () => {
    const restart = await world.reconnectAfterRestart();
    expect(restart.timeOrigin).not.toBe(restart.originalTimeOrigin);
    await probe.eventually(() => messages(world.active.sessionId), { within: 90_000, label: "startup produces the continuation reply on the original engine",
      until: (items) => items.some((message) => message.role === "assistant" && message.parts.some((part) => part.type === "text" && part.text === world.recovery.reply)) });
    const history = await messages(world.active.sessionId);
    expect(history.filter((message) => message.role === "user" && message.parts.some((part) => typeof part.text === "string" && part.text.includes(world.recovery.marker)))).toHaveLength(1);
    expect((await messages(world.stopped.sessionId)).map((message) => message.id)).toEqual(stoppedBefore.map((message) => message.id));
    expect((await messages(world.completed.sessionId)).map((message) => message.id)).toEqual(completedBefore.map((message) => message.id));
    expect((await world.mock.agentRequests({ promptMarker: world.active.prompt })).filter((call) => call.kind === "tool")).toHaveLength(1);
    expect((await world.mock.agentRequests({ promptMarker: world.recovery.marker })).filter((call) => call.kind === "final")).toHaveLength(1);
    const observeUntil = Date.now() + 6_000;
    await probe.eventually(async () => {
      expect((await messages(world.stopped.sessionId)).map((message) => message.id)).toEqual(stoppedBefore.map((message) => message.id));
      expect((await messages(world.completed.sessionId)).map((message) => message.id)).toEqual(completedBefore.map((message) => message.id));
      expect((await world.mock.agentRequests({ promptMarker: world.recovery.marker })).filter((call) => call.kind === "final")).toHaveLength(1);
      return Date.now() >= observeUntil;
    }, { within: 10_000, label: "later recovery ticks do not duplicate work or restart excluded tasks", until: Boolean });
    await agent.run("session.open", { sessionId: world.active.sessionId });
    await user.see({ text: world.recovery.reply });
    await user.screenshot();
  });
});
