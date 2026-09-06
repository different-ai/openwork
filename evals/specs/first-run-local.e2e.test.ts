import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { bareFirstRunWorld } from "../worlds/first-run.ts";

const test = spec.world(bareFirstRunWorld);
const prompt = "Create a short welcome checklist for this OpenWork workspace. Use exactly three bullets and mention one thing I can do next.";

test("first use without an invite or cloud reaches local task UI with honest model setup", async ({ world, user, probe, step, evidence }) => {
  await step("Welcome", async () => {
    await user.see({ text: "Welcome to OpenWork" });
    await user.see("Use Without Cloud");
    await user.see({ text: "Draft with files" });
    await user.see({ text: "Reuse skills" });
    await user.see({ text: "Connect tools via MCP" });
    await user.see({ text: "Choose a folder, then a model. No OpenWork account needed." });
    await user.see({ testId: "welcome-team-signin" });
    await user.see({ testId: "welcome-join-org" });
    expect(await probe.eval(`(() => {
      const local = document.querySelector('[data-testid="welcome-use-without-cloud"]');
      const cloud = document.querySelector('[data-testid="welcome-team-signin"]');
      return Boolean(local && cloud && (local.compareDocumentPosition(cloud) & Node.DOCUMENT_POSITION_FOLLOWING));
    })()`)).toBe(true);
    await user.notSee({ text: "Run task" });
    await user.screenshot();
    evidence.recordAssertionEvidence("First launch explains files, skills, and MCP connections before setup, with local setup first and cloud entry still available", "All three capabilities and model/account requirements are visible; the local action precedes cloud sign-in in reading order, both cloud routes remain visible, and no task can run on the welcome screen.", true);
    await user.notSee({ text: /Something went wrong/ });
  });

  await step("Choose a local folder", async () => {
    await user.click("Use Without Cloud");
    await user.type({ placeholder: "/workspace/my-project" }, world.workspacePath);
    await user.click("Use this folder");
    await user.see({ text: "Power your first task" }, { timeoutMs: 120_000 });
    await user.see({ text: "Bring your own API key" });
    evidence.recordAssertionEvidence("Use Without Cloud reaches model setup using the selected local folder", "The existing folder picker accepted the test workspace and opened Power your first task without requesting OpenWork sign-in.", true);
  });

  await step("Finish onboarding", async () => {
    await user.click("Skip and use the free model");
    await user.see({ text: "How did you hear about OpenWork?" }, { timeoutMs: 90_000 });
    await user.click("Skip");
    await user.see({ text: /What do you need done\?/ }, { timeoutMs: 180_000 });
    await user.see("Run task");
  });

  const composer = await probe.composer();
  expect(composer.route).toContain("/workspace/");
  expect(composer.route).toContain("/session");
  expect(composer.runTaskVisible).toBe(true);
  await user.notSee({ text: /Something went wrong/ });
  await user.see({ text: /Using the free starter model/ });
  await user.type("composer", prompt);

  if (!(await probe.composer()).runTaskEnabled) {
    await user.see("Connect a model provider");
    return;
  }

  await step("Run the first task or hear honestly why the free model can't", async () => {
    await user.click("Run task");
    await user.see({ text: prompt }, { timeoutMs: 30_000 });
    const outcome = await probe.eventually(
      async () => {
        const composer = await probe.composer();
        if (composer.assistantMessageCount > 0) return "replied";
        const busy = await probe.has("The free starter model is busy right now");
        return busy ? "free-model-busy" : null;
      },
      { within: 180_000, label: "assistant reply or honest free-model notice", until: (value) => value !== null },
    );
    expect(outcome === "replied" || outcome === "free-model-busy").toBe(true);
    if (outcome === "free-model-busy") {
      await user.see({ text: "The free starter model is busy right now" });
    }
    await user.notSee({ text: /subscribe to Go/i });
    await user.notSee({ text: /Error from provider/ });
    await user.notSee({ text: /Something went wrong/ });
  });
});
