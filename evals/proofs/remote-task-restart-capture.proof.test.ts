import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { setTimeout as wait } from "node:timers/promises";
import { remoteTaskRestartBrowser } from "../worlds/infra/remote-task-restart-browser.ts";
import { CHAT_PROMPT, CHAT_TITLE, COMPUTER_LABEL, DRAFT, TASK_TITLE, remoteSessionHelperViewWorld } from "../worlds/remote-session-helper-view.ts";

const test = spec.world(remoteSessionHelperViewWorld, { timeout: 240_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, needs: { commands: ["bun"] } });
const followUp = { role: "textbox" as const, label: "Follow up" };
const breadcrumb = { role: "button" as const, label: `Back to ${CHAT_TITLE}` };
const row = { role: "button" as const, label: `${TASK_TITLE}. Open the task on ${COMPUTER_LABEL}` };
const viewport = { width: 1280, height: 900, deviceScaleFactor: 1 };

test("the owner keeps a Studio computer draft through a fresh window and a visit to the parent chat", async ({ world, user, probe, agent, step, evidence }) => {
  const browser = remoteTaskRestartBrowser(world.app);
  const hold = (ms: number) => browser.recording ? wait(ms) : undefined;
  await user.resizeViewport(viewport);
  await user.see("composer", { editable: true, timeoutMs: 60_000 });
  const parentUrl = await browser.currentUrl();
  await agent.send(CHAT_PROMPT);
  await user.see(row, { timeoutMs: 60_000 });
  let oldFilm = await browser.film("01-before-close");
  let newFilm: Awaited<ReturnType<typeof browser.film>>;
  let appUrl = "";
  try {
    await step("the owner opens the task on Studio computer and types an unsent follow-up", async () => {
      await hold(900);
      await user.click(row);
      await user.see(breadcrumb, { timeoutMs: 30_000 });
      await user.see(followUp, { editable: true, timeoutMs: 30_000 });
      await user.see({ text: COMPUTER_LABEL });
      appUrl = await browser.currentUrl();
      if (browser.recording) {
        await hold(750);
        await user.click(followUp);
        await browser.typeForFilm(DRAFT);
      } else await user.type(followUp, DRAFT, { verify: true });
      const typed = await browser.draft();
      const received = world.followUps();
      evidence.recordAssertionEvidence("Nothing was sent yet", `Typed: ${JSON.stringify(typed)}. Follow-ups received: ${received.length}.`, typed === DRAFT && received.length === 0);
      expect(typed).toBe(DRAFT);
      expect(received).toEqual([]);
      await user.screenshot();
      await hold(1750);
    });
    await oldFilm?.stop();
    oldFilm = undefined;
    await step("the owner closes the app window and opens the same task address in a new one", async () => {
      const { originalGone, replacementAttached } = await browser.replaceWindow();
      expect(originalGone && replacementAttached).toBe(true);
      await user.resizeViewport(viewport);
      expect(await browser.currentUrl()).toBe("about:blank");
      await browser.watchReopen();
      newFilm = await browser.film("02-after-close");
      await hold(750);
      await user.navigate(appUrl);
      const reopenedUrl = await probe.eventually(browser.currentUrl, { within: 10_000, until: url => url === appUrl });
      const sameRoute = reopenedUrl === appUrl;
      evidence.recordAssertionEvidence("The original viewing window is gone", "The old browser window closed, and a different window opened the same task address.", originalGone && replacementAttached && sameRoute);
      expect(sameRoute).toBe(true);
    });
    await step("after: Studio computer and the unsent draft are present as soon as they are visible", async () => {
      await user.see(followUp, { editable: true, timeoutMs: 30_000 });
      await user.see({ text: COMPUTER_LABEL });
      await hold(2000);
      const first = await probe.eventually(browser.reopenWitness, { within: 5_000, until: value => value?.firstDraft != null && value.firstComputer != null });
      const expected = { firstComputer: COMPUTER_LABEL, firstDraft: DRAFT, sawLocalFallback: false, sawMissingTask: false };
      const stored = await browser.draft();
      const received = world.followUps();
      evidence.recordAssertionEvidence("No local-computer or missing-task fallback appeared", `First label: ${JSON.stringify(first?.firstComputer)}. First draft: ${JSON.stringify(first?.firstDraft)}. Local fallback: ${first?.sawLocalFallback}. Missing task: ${first?.sawMissingTask}. Follow-ups received: ${received.length}.`, first?.firstComputer === COMPUTER_LABEL && first.firstDraft === DRAFT && !first.sawLocalFallback && !first.sawMissingTask && stored === DRAFT && received.length === 0);
      // Keep filming the round trip if startup flashes a fallback; the proof still fails.
      expect.soft(first).toEqual(expected);
      expect(stored).toBe(DRAFT);
      expect(received).toEqual([]);
      await user.screenshot();
    });
    await step("after: the parent chat still lists Studio computer under Agents", async () => {
      await user.click(breadcrumb);
      await user.see("composer", { editable: true, timeoutMs: 30_000 });
      await user.see(row, { timeoutMs: 30_000 });
      const tracker = await probe.dom("[data-subagent-tracker] [data-subagent-tracker-remote]");
      const visibleTask = tracker.elements.find(item => item.rect.width > 0 && item.rect.height > 0 && item.text.includes(TASK_TITLE));
      const returnedTo = await browser.currentUrl();
      evidence.recordAssertionEvidence("The task stays attached to its chat", `Agents row: ${JSON.stringify(visibleTask?.text)}. Returned to original chat: ${returnedTo === parentUrl}.`, returnedTo === parentUrl && Boolean(visibleTask?.text.includes(COMPUTER_LABEL)));
      expect(returnedTo).toBe(parentUrl);
      expect(visibleTask?.text).toContain(COMPUTER_LABEL);
      await user.screenshot();
      await hold(2250);
    });
    await step("after: opening the task from Agents brings back the same unsent draft", async () => {
      await user.click(row);
      await user.see(followUp, { editable: true, timeoutMs: 30_000 });
      await user.see({ text: COMPUTER_LABEL });
      const returnedTo = await browser.currentUrl();
      const restored = await browser.draft();
      const received = world.followUps();
      evidence.recordAssertionEvidence("The draft survives the round trip", `Returned to the same task: ${returnedTo === appUrl}. Draft: ${JSON.stringify(restored)}. Follow-ups received: ${received.length}.`, returnedTo === appUrl && restored === DRAFT && received.length === 0);
      expect(returnedTo).toBe(appUrl);
      expect(restored).toBe(DRAFT);
      expect(received).toEqual([]);
      await user.screenshot();
      await hold(1750);
    });
    await step("the owner sends the restored draft and sees it in the task transcript", async () => {
      await user.click(followUp);
      await user.press("Enter");
      await probe.eventually(world.followUps, { within: 30_000, until: messages => messages.length > 0 });
      await user.see({ text: DRAFT }, { timeoutMs: 30_000 });
      await hold(2500);
      const transcript = await probe.dom("[data-remote-session-surface] [data-remote-thread-transcript]");
      const inTranscript = transcript.elements.some(item => item.rect.height > 0 && item.text.includes(DRAFT));
      const received = world.followUps();
      const remaining = await browser.draft();
      evidence.recordAssertionEvidence("The runner received the draft once", `Follow-ups received by the runner: ${JSON.stringify(received)}. Present in transcript: ${inTranscript}. Composer remaining: ${JSON.stringify(remaining)}.`, received.length === 1 && received[0] === DRAFT && inTranscript && remaining === "");
      expect(received).toEqual([DRAFT]);
      expect(inTranscript).toBe(true);
      expect(remaining).toBe("");
      await user.screenshot();
    });
  } finally {
    await oldFilm?.stop();
    await newFilm?.stop();
  }
});
