import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { remoteSessionAnswers } from "../worlds/remote-session-answers.ts";

const test = spec.world(remoteSessionAnswers, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { commands: ["bun"] },
});

const ANSWER_MS = 90_000;

test("a person answers the question a task on their other computer asks, from the chat they are in", async ({ world, user, probe, step, evidence }) => {
  await step("by default the row offers the task's options and Other answer…", async () => {
    await user.see("composer", { editable: true });
    await user.type("composer", world.prompt);
    await user.press("Enter");
    await user.see({ role: "button", label: "Answer dev" }, { timeoutMs: ANSWER_MS });
    await user.see({ role: "button", label: "Answer main" });
    await user.see({ role: "button", label: "Other answer…" });
    const labels = (await probe.dom("[data-remote-thread-answers] button")).elements.map((element) => element.text.trim());
    expect(labels).toEqual(["dev", "main", "Other answer…"]);
    evidence.recordAssertionEvidence("A single-choice question shows its options on the row", `buttons: ${labels.join(", ")}`, labels.length === 3);
    await user.screenshot();
  });

  await step("the panel shows the question as text above the follow-up box", async () => {
    await user.click({ role: "button", label: "Other answer…" });
    await user.see({ text: world.question.question }, { timeoutMs: 60_000 });
    await user.see({ text: `Question from ${world.computer}` });
    await user.see({ text: "Everything merged since the last release" });
    await user.see({ role: "button", label: "Send answer" });
    const options = (await probe.dom("[data-remote-answer-option]")).elements.map((element) => element.text.trim());
    expect(options).toHaveLength(2);
    evidence.recordAssertionEvidence("The card names the computer, the question and each option with its description",
      `"Question from ${world.computer}" / "${world.question.question}" / ${options.join(" | ")}`, options.length === 2);
    await user.screenshot();
  });

  await step("choosing main and sending reaches the other computer once; its next step needs approval", async () => {
    await user.click({ role: "radio", label: "main" });
    await user.click({ role: "button", label: "Send answer" });
    const answers = await probe.eventually(async () => world.answers(), { within: 60_000, label: "the computer receives the answer", until: (value) => value.length > 0 });
    expect(answers).toEqual([{ kind: "question", requestId: "form_branch", answers: [["main"]] }]);
    await user.see({ text: `Permission on ${world.computer}` }, { timeoutMs: 60_000 });
    await user.see({ text: "gh release create v2.4.0 --draft --notes-file release-notes.md" });
    await user.notSee({ role: "button", label: "Send answer" });
    evidence.recordAssertionEvidence("The Studio Mac received exactly the person's choice, once", JSON.stringify(answers), answers.length === 1);
    await user.screenshot();
  });

  await step("after: allowing it once finishes the task, and nothing was approved for always", async () => {
    await user.click({ role: "button", label: "Allow once" });
    await user.see({ text: "Release notes drafted from main and published as a draft: 14 changes in 3 sections." }, { timeoutMs: 60_000 });
    const answers = world.answers();
    expect(answers.at(-1)).toEqual({ kind: "permission", requestId: "per_publish", decision: "once" });
    expect((await probe.dom("[data-remote-thread-state=waiting]")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("The approval reached the computer as once", JSON.stringify(answers.at(-1)), answers.length === 2);
    await user.screenshot();
  });
});
