import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { pathPrompt } from "../worlds/path-prompt.ts";

const test = spec.world(pathPrompt, {
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

const missingFileError = "File not found: /Applications/Open";

test("a person who starts a prompt with a path containing spaces gets an answer instead of a missing-file error", async ({ world, user, probe, step, evidence }) => {
  await step("before: the path cut at its space, /Applications/Open, is attached as a file and fails with File not found: /Applications/Open", async () => {
    const [path, question] = world.cutPrompt.split("\n");
    await user.click({ role: "button", label: new RegExp(`^${world.beforeTitle}`) });
    await user.type("composer", path ?? "");
    await user.press("Shift+Enter");
    await user.type("composer", question ?? "");
    await user.click("Run task");
    await user.see({ text: missingFileError }, { timeoutMs: 90_000 });
    const line = (await probe.text()).split("\n").find((entry) => entry.includes(missingFileError))?.trim() ?? "";
    evidence.recordAssertionEvidence("The engine reports the cut-off path as a missing file", line.slice(0, 200), line.length > 0);
    await user.screenshot();
  });

  await step("then the model still answered that turn, so the error came only from reading the attached path", async () => {
    await user.see({ text: world.cutReply }, { timeoutMs: 90_000 });
    const answered = await world.answered(world.cutMarker);
    evidence.recordAssertionEvidence("The model answered the cut-off path turn", `${answered} model reply for "${world.cutMarker}"; "${world.cutReply}" shown under the error`, answered > 0);
    expect(answered).toBeGreaterThan(0);
  });

  await step("after: /Applications/Open Coworker.app is sent as ordinary text and answered, with no File not found error or suggested paths", async () => {
    await user.click({ role: "button", label: new RegExp(`^${world.afterTitle}`) });
    await user.type("composer", world.prompt, { verify: true });
    await user.click("Run task");
    await user.see({ text: world.reply }, { timeoutMs: 90_000 });
    await user.see({ text: world.prompt });
    await user.notSee({ text: "File not found" });
    await user.notSee({ text: "Did you mean" });
    const answered = await world.answered(world.marker);
    evidence.recordAssertionEvidence("The whole path reached the model as text without a read failure",
      `prompt "${world.prompt}" shown as sent; ${answered} model reply "${world.reply}"; no "File not found" or "Did you mean" on screen`, answered > 0);
    expect(answered).toBeGreaterThan(0);
    await user.screenshot();
  });
});
