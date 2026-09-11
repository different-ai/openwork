import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { currentTestEvidence } from "@openwork/test-evidence";
import { restartUpdateTaskWorld } from "../worlds/chat.ts";
import { queuedFollowUps } from "../worlds/session-draft.ts";

const test = spec.world(queuedFollowUps, {
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  timeout: 240_000,
});

function assertObserved(assertion: string, observed: Record<string, unknown>, passed: boolean) {
  currentTestEvidence()?.recordAssertionEvidence(assertion, JSON.stringify(observed), passed);
  expect(passed, assertion).toBe(true);
}

// Busy Enter queues ("Send when agent finishes"); Cmd/Ctrl+Enter would steer.
const enter = "Enter";
const draftsKey = "openwork.session-drafts.v2";

type StoredDrafts = { text: string; queued: string[] }[];

function readDrafts(value: unknown, sessionId: string): StoredDrafts {
  if (typeof value !== "object" || value === null || !("drafts" in value) || typeof value.drafts !== "object" || value.drafts === null) return [];
  return Object.entries(value.drafts).filter(([key]) => key.includes(sessionId)).map(([, entry]) => {
    const record: Record<string, unknown> = typeof entry === "object" && entry !== null ? { ...entry } : {};
    const queued = Array.isArray(record.queued) ? record.queued.filter((item): item is string => typeof item === "string") : [];
    return { text: typeof record.text === "string" ? record.text : "", queued };
  });
}

test("queued follow-ups come back as an unsent draft after a renderer restart instead of vanishing or auto-sending", async ({ world, user, probe, step }) => {
  const second = "Also tag the build";
  const draft = "Draft typed after queueing";
  const userMessages = () => probe.dom('[data-message-role="user"]');
  const storedDrafts = () => probe.storage(draftsKey, (value) => readDrafts(value, world.session.sessionId));

  await step("start a long task and queue two follow-ups while it runs", async () => {
    await user.type("composer", world.running.prompt, { verify: true });
    await user.press(enter);
    await user.see({ text: "Building the release." });
    await user.type("composer", world.queued.prompt, { verify: true });
    await user.press(enter);
    await user.see({ text: /1 queued/ });
    await user.type("composer", second, { verify: true });
    await user.press(enter);
    await user.see({ text: /2 queued/ });
    await user.see("composer", { editable: true, text: "" });
    const rows = (await userMessages()).elements;
    assertObserved("Queued follow-ups wait in the panel and are not sent while the task runs",
      { rows: rows.length, queuedRequests: (await world.modelRequests(world.queued.prompt)).length },
      rows.length === 1 && (await world.modelRequests(world.queued.prompt)).length === 0);
  });

  await step("type a draft after queueing; storage keeps both the draft and the queue", async () => {
    await user.type("composer", draft, { verify: true });
    const stored = await probe.eventually(storedDrafts, {
      within: 10_000, label: "draft and queue persisted for this conversation",
      until: (entries) => entries.length === 1 && entries[0]!.text === draft && entries[0]!.queued.length === 2,
    });
    assertObserved("The persisted draft entry records the composer text and both queued messages in order",
      { stored, expected: { text: draft, queued: [world.queued.prompt, second] } },
      stored.length === 1 && stored[0]!.text === draft
        && stored[0]!.queued[0] === world.queued.prompt && stored[0]!.queued[1] === second);
    await user.screenshot();
  });

  await step("reload the renderer while the task is still running", async () => {
    await user.reload();
    await user.see({ text: world.running.prompt });
    await user.see("composer", { editable: true, text: /Then publish the release notes[\s\S]*Also tag the build[\s\S]*Draft typed after queueing/ });
    await user.notSee({ text: /queued/ });
    const composer = (await probe.composer()).draftText;
    const rows = (await userMessages()).elements;
    const stored = await storedDrafts();
    const toast = (await probe.dom("[data-sonner-toast]")).elements.map((element) => element.text).join(" | ");
    assertObserved("After reload the queue is folded into the composer in order, nothing was sent, and the person is told",
      { composer, rows: rows.length, stored, toast, queuedRequests: (await world.modelRequests(world.queued.prompt)).length },
      composer.startsWith(world.queued.prompt) && composer.includes(second) && composer.endsWith(draft)
        && rows.length === 1 && stored.length === 1 && stored[0]!.queued.length === 0
        && /2 messages waiting to be sent/.test(toast) && /kept as a draft/.test(toast));
    await user.screenshot();
  });

  await step("finishing the task afterwards does not send the restored text on its own", async () => {
    await world.releaseRunningReply();
    await user.see({ text: /Build finished\./ });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const rows = (await userMessages()).elements;
    const composer = (await probe.composer()).draftText;
    assertObserved("Idle after restart never drains a restored queue: one user turn, text still in the composer, no model call for it",
      { rows: rows.length, composer, queuedRequests: (await world.modelRequests(world.queued.prompt)).length },
      rows.length === 1 && composer.includes(world.queued.prompt) && (await world.modelRequests(world.queued.prompt)).length === 0);
  });
});

test("a queued follow-up already admitted to the engine is neither duplicated nor restored after a reload", async ({ world, user, probe, step }) => {
  const userMessages = () => probe.dom('[data-message-role="user"]');
  const storedDrafts = () => probe.storage(draftsKey, (value) => readDrafts(value, world.session.sessionId));

  await step("queue one follow-up, then let the running task finish so the drain admits it", async () => {
    await user.type("composer", world.running.prompt, { verify: true });
    await user.press(enter);
    await user.see({ text: "Building the release." });
    await user.type("composer", world.queued.prompt, { verify: true });
    await user.press(enter);
    await user.see({ text: /1 queued/ });
    await world.releaseRunningReply();
    await user.see({ text: /Build finished\./ });
    await user.see({ text: "Publishing the notes." });
    await user.notSee({ text: /1 queued/ });
    const rows = (await userMessages()).elements;
    const stored = await storedDrafts();
    assertObserved("Admission moves the follow-up into the transcript and out of persisted queue storage",
      { rows: rows.length, stored }, rows.length === 2 && stored.every((entry) => entry.queued.length === 0));
  });

  await step("reload while the admitted follow-up is still running", async () => {
    await user.reload();
    await user.see({ text: world.queued.prompt });
    await user.see("composer", { editable: true, text: "" });
    await user.notSee({ text: /queued/ });
    const rows = (await userMessages()).elements;
    const matching = rows.filter((row) => row.text.includes(world.queued.prompt)).length;
    const toasts = (await probe.dom("[data-sonner-toast]")).elements.length;
    assertObserved("The admitted follow-up appears exactly once, is not re-queued, not restored as a draft, and raises no restore notice",
      { rows: rows.length, matching, composer: (await probe.composer()).draftText, toasts },
      rows.length === 2 && matching === 1 && toasts === 0);
    await world.releaseQueuedReply();
    await user.see({ text: /Notes published\./ });
    expect((await userMessages()).elements).toHaveLength(2);
  });
});

const desktopTest = spec.world(restartUpdateTaskWorld, { timeout: 600_000 });

desktopTest("Restart to update names the waiting message and the relaunched desktop hands it back unsent while the task resumes", async ({ world, user, agent, probe, step }) => {
  user = user.on(world.app);
  agent = agent.on(world.app);
  probe = probe.on(world.app);
  const queuedText = "After the report, archive the inputs";
  const v2 = world.engine === "v2";
  const mount = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/${v2 ? "opencode2/api" : "opencode"}`;
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an engine record");
    return Object.fromEntries(Object.entries(value));
  };
  const userTexts = async () => {
    const response = await probe.desktopApi(`${mount}/session/${world.active.sessionId}/${v2 ? "context" : "message?limit=100"}`);
    expect(response.status).toBe(200);
    const value = v2 ? record(response.body).data : response.body;
    if (!Array.isArray(value)) throw new Error("Expected engine messages");
    return value.flatMap((entry: unknown) => {
      const message = record(entry);
      const info = v2 ? message : record(message.info);
      const parts = v2 ? message.content : message.parts;
      if (info[v2 ? "type" : "role"] !== "user" || !Array.isArray(parts)) return [];
      return parts.map(record).flatMap((part) => typeof part.text === "string" ? [part.text] : []);
    });
  };

  await step("queue a follow-up behind a running desktop task, then ask to restart for the update", async () => {
    await user.click({ text: world.active.title });
    await probe.eventually(() => probe.hash(), { within: 30_000, label: "the active task is selected",
      until: (hash) => hash.includes(`/session/${world.active.sessionId}`) });
    await user.type("composer", world.active.prompt, { verify: true });
    await user.press(enter);
    await probe.eventually(userTexts, { within: 30_000, label: "the task's prompt is admitted", until: (texts) => texts.length === 1 });
    await user.type("composer", queuedText, { verify: true });
    await user.press(enter);
    await user.see({ text: /1 queued/ });
    await agent.run("settings.panel.open", { panel: "updates" });
    await user.click({ role: "button", text: "Check now" });
    await user.see({ text: "Restart to update" }, { timeoutMs: 30_000 });
    await user.click({ text: "Restart to update" });
    await user.see({ text: "Restart OpenWork?" });
    const notice = (await probe.dom('[data-testid="update-restart-waiting-messages"]')).elements.map((element) => element.text).join(" ");
    assertObserved("The restart dialog says one waiting message will be kept as a draft and not sent on its own",
      { notice }, /1 message waiting to be sent/.test(notice) && /kept as a draft/.test(notice));
    await user.screenshot();
    await user.click("Restart & update");
  });

  await step("after the relaunch the follow-up is an unsent draft while the interrupted task resumes without it", async () => {
    const restart = await world.reconnectAfterRestart();
    expect(restart.timeOrigin).not.toBe(restart.originalTimeOrigin);
    await agent.run("session.open", { sessionId: world.active.sessionId });
    await user.see("composer", { editable: true, text: queuedText, timeoutMs: 60_000 });
    await user.notSee({ text: /1 queued/ });
    await user.see({ text: /1 message waiting to be sent was kept as a draft/ });
    await user.see({ text: world.recovery.reply }, { timeoutMs: 90_000 });
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const texts = await userTexts();
    const composer = (await probe.composer()).draftText;
    assertObserved("The resumed task ran once and the queued follow-up was never sent: not in the transcript, still in the composer",
      { texts, composer, queuedText },
      texts.filter((text) => text.includes(queuedText)).length === 0
        && texts.filter((text) => text.includes(world.recovery.marker)).length === 1
        && composer.includes(queuedText)
        && (await world.mock.agentRequests({ promptMarker: queuedText })).length === 0);
    await user.screenshot();
  });
});
