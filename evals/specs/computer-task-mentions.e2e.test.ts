import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { computerMentions } from "../worlds/chat.ts";

const test = spec.world(computerMentions);

test("computer mentions steer tasks through Connect and Automations names the computer", async ({ world, user, probe, step, evidence }) => {
  await step("the mention menu explains both computers without starting a task", async () => {
    await user.type("composer", "@");
    await user.see({ text: "Start a task on your cloud computer" });
    await user.see({ text: "Start a task on your connected desktop computer" });
    await user.screenshot();
    expect((await probe.composer()).userMessageCount).toBe(0);
    await user.type("composer", "cl", { replace: false });
    await user.see({ text: "Start a task on your cloud computer" });
    await user.notSee({ text: "Start a task on your connected desktop computer" });
    await user.click({ role: "button", label: /@cloud/ });
    await user.type("composer", "COMPUTER-CLOUD-TASK Summarize the project notes.");
    await user.press("Enter");
    await user.see({ text: "Received computer task.", nth: 0 }, { timeoutMs: 90_000 });
  });

  await step("typing desktop directly works without selecting the menu", async () => {
    await user.click({ role: "button", label: "New task" });
    await user.type("composer", "@desktop COMPUTER-DESKTOP-TASK Summarize my local project notes.");
    await user.press("Enter");
    await user.see({ text: "Received computer task.", nth: 0 }, { timeoutMs: 90_000 });
    await user.click({ role: "button", label: "New task" });
    await user.type("composer", "COMPUTER-PLAIN-TASK Explain the address person@cloud and the word desktop.");
    await user.press("Enter");
    await user.see({ text: "Received computer task.", nth: 0 }, { timeoutMs: 90_000 });
  });

  await step("computer handoffs reach Connect, while ordinary text makes no tool call", async () => {
    const messages = await world.submittedParts();
    expect(messages).toEqual([
      { visible: "@cloud COMPUTER-CLOUD-TASK Summarize the project notes.", routing: [expect.stringContaining('target "cloud"')] },
      { visible: "@desktop COMPUTER-DESKTOP-TASK Summarize my local project notes.", routing: [expect.stringContaining('target "desktop"')] },
      { visible: "COMPUTER-PLAIN-TASK Explain the address person@cloud and the word desktop.", routing: [] },
    ]);
    const calls = await probe.toolCalls(world.den.mocks.agent);
    expect(calls.map(({ name, args }) => ({ name, args }))).toEqual([
      { name: "search_capabilities", args: { query: "remote-session:create" } },
      { name: "execute_capability", args: { name: "remote-session:create", body: { target: "cloud", prompt: "COMPUTER-CLOUD-TASK Summarize the project notes." } } },
      { name: "search_capabilities", args: { query: "remote-session:create" } },
      { name: "execute_capability", args: { name: "remote-session:create", body: { target: "desktop", prompt: "COMPUTER-DESKTOP-TASK Summarize my local project notes." } } },
    ]);
    await user.notSee({ text: /Use OpenWork Connect search_capabilities/ });
    evidence.recordAssertionEvidence("Computer mentions reach the Connect boundary", "Menu-selected @cloud and typed @desktop submit distinct synthetic Connect routing instructions. The Connect witness serves search and create calls with the matching target and full task. An email address makes no tool call, and routing instructions stay out of the visible chat.", true);
  });

  await step("Automations shows where the task runs and explains desktop availability", async () => {
    await user.click({ role: "button", label: /^Automations$/ });
    await user.see({ text: "Schedule tasks on your desktop or cloud computer. See where each task runs and how it went." });
    await user.see({ text: "Daily project summary" });
    await user.see({ text: /^Desktop computer$/ });
    await user.notSee({ text: /Scheduled durably|headlessly|fixed Desktop/ });
    await user.screenshot();
    await user.click({ role: "button", label: /Daily project summary/ });
    await user.see({ text: "Runs on your desktop computer. Keep OpenWork open and connected at the scheduled time." });
    evidence.recordAssertionEvidence("Automation placement is visible and understandable", "The automation list labels its desktop computer; the detail explains that OpenWork must stay open and connected without runtime terminology.", true);
  });
});
