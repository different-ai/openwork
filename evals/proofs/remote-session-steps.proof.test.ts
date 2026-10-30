import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  CHAT_PROMPT, CHAT_REPLY, COMPUTER_LABEL, FAILURE, FIRST_ANSWER, MISSING_FILE, SECOND_ANSWER, TASK_TITLE,
  remoteSessionStepsWorld,
} from "../worlds/remote-session-steps.ts";

const test = spec.world(remoteSessionStepsWorld, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, timeout: 600_000,
});

const PANEL = "[data-remote-thread-panel]";

test("a member opens a task running on their other computer and reads every step it took, folded like their own chat, with the failed step's details", async ({ world, user, probe, step, evidence }) => {
  const panelText = async () => (await probe.dom(PANEL)).elements.map((element) => element.text).join(" ");

  await step("the member's chat hands the release notes check to their other computer", async () => {
    await user.see("composer", { editable: true });
    await user.type("composer", CHAT_PROMPT);
    await probe.eventually(() => probe.dom('button[aria-label="Run task"]:not(:disabled)'), {
      within: 30_000, label: "the conversation is ready to run the task", until: (value) => value.elements.length === 1,
    });
    await user.click("Run task");
    await user.see({ text: CHAT_REPLY }, { timeoutMs: 120_000 });
    await user.see({ text: TASK_TITLE }, { timeoutMs: 60_000 });
    const rows = (await probe.dom("[data-remote-thread]")).elements.map((element) => element.text);
    evidence.recordAssertionEvidence("The chat shows the task as one row", `rows: ${JSON.stringify(rows)}`, rows.length === 1);
    expect(rows).toHaveLength(1);
    await user.screenshot();
  });

  await step("after: the open task shows each step its computer took, and the finished turn folds to one line", async () => {
    await user.click({ label: new RegExp(`${TASK_TITLE}\\. Open the task on`) });
    await user.see({ text: FIRST_ANSWER }, { timeoutMs: 90_000 });
    await user.see({ text: SECOND_ANSWER }, { timeoutMs: 30_000 });
    const folds = (await probe.dom(`${PANEL} [data-testid="completed-work-rail"]`)).elements.map((element) => element.text);
    const text = await panelText();
    const ok = folds.length === 1 && /^Worked for 42s/.test(folds[0] ?? "") && text.includes(MISSING_FILE) && text.includes(COMPUTER_LABEL)
      && !text.includes("Working");
    evidence.recordAssertionEvidence("One folded finished turn; the turn with a failure stays open", `folds: ${JSON.stringify(folds)}; failed step shown: ${text.includes(MISSING_FILE)}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("opening the folded turn lists its command and file read in the order they ran", async () => {
    await user.click({ label: /^Worked for 42s, 2 steps\. Show steps$/ });
    await user.see({ text: "Ran command, read 1 file" });
    await user.click({ text: "Ran command, read 1 file" });
    await probe.eventually(() => panelText(), {
      within: 15_000, label: "the folded steps open", until: (value) => /List the release notes|ls docs\/releases/.test(value) && value.includes("v1.1.md"),
    });
    const text = await panelText();
    const command = text.search(/List the release notes|ls docs\/releases/);
    const read = text.indexOf("v1.1.md");
    const answer = text.indexOf(FIRST_ANSWER);
    const ok = command >= 0 && read > command && answer > read;
    evidence.recordAssertionEvidence("Steps read in native order: command, file read, answer", `positions command ${command}, read ${read}, answer ${answer}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("the failed read stays open in red with what went wrong", async () => {
    // Back to the end of the conversation, where the failed turn is.
    await user.wheelAt({ x: 1080, y: 400, deltaY: 2400 });
    await user.see({ text: FAILURE });
    const failed = (await probe.dom(`${PANEL} .text-red-11, ${PANEL} .text-destructive`)).elements.map((element) => element.text);
    const reads = world.runnerReads().length;
    const ok = failed.some((text) => text.includes("Read")) && reads > 0;
    evidence.recordAssertionEvidence("The failure came from the other computer's transcript and reads as a failed step", `red text: ${JSON.stringify(failed)}; error: ${FAILURE}; reads the computer answered: ${reads}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });
});
