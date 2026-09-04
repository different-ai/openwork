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
    await user.see({ text: "Received COMPUTER-CLOUD-TASK" }, { timeoutMs: 90_000 });
  });

  await step("typing desktop directly works without selecting the menu", async () => {
    await user.type("composer", "@desktop COMPUTER-DESKTOP-TASK Summarize my local project notes.");
    await user.press("Enter");
    await user.see({ text: "Received COMPUTER-DESKTOP-TASK" }, { timeoutMs: 90_000 });
    await user.type("composer", "COMPUTER-PLAIN-TASK Explain the address person@cloud and the word desktop.");
    await user.press("Enter");
    await user.see({ text: "Received COMPUTER-PLAIN-TASK" }, { timeoutMs: 90_000 });
  });

  await step("the engine receives the chosen target, while ordinary text is not routed", async () => {
    // TODO(primitive): inspect submitted engine parts, including synthetic routing instructions.
    const messages = await probe.eval(`async (workspaceId, sessionId) => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId)
        + "/opencode/session/" + encodeURIComponent(sessionId) + "/message", {
        headers: { Authorization: "Bearer " + token },
      });
      if (!response.ok) throw new Error("Transcript read failed: " + response.status);
      const messages = await response.json();
      return messages.filter((message) => message.info.role === "user").map((message) => ({
        visible: message.parts.filter((part) => part.type === "text" && !part.synthetic).map((part) => part.text).join(""),
        routing: message.parts.filter((part) => part.type === "text" && part.synthetic && part.text.includes("remote-session:create")).map((part) => part.text),
      }));
    }`, { args: [world.workspace.workspaceId, world.session.sessionId], awaitPromise: true });
    expect(messages).toEqual([
      { visible: expect.stringContaining("@cloud COMPUTER-CLOUD-TASK"), routing: [expect.stringContaining('target "cloud"')] },
      { visible: expect.stringContaining("@desktop COMPUTER-DESKTOP-TASK"), routing: [expect.stringContaining('target "desktop"')] },
      { visible: expect.stringContaining("person@cloud"), routing: [] },
    ]);
    await user.notSee({ text: /Use OpenWork Connect search_capabilities/ });
    evidence.recordAssertionEvidence("Computer mentions preserve the target at the engine boundary", "Menu-selected @cloud and typed @desktop submit distinct synthetic Connect routing instructions. An email address does not route, and implementation instructions stay out of the visible chat.", true);
  });

  await step("Automations shows where the task runs and explains desktop availability", async () => {
    await user.click({ role: "button", label: "Automations", exact: true });
    await user.see({ text: "Schedule tasks on your desktop or cloud computer. See where each task runs and how it went." });
    await user.see({ text: "Daily project summary" });
    await user.see({ text: "Desktop computer", exact: true });
    await user.notSee({ text: /Scheduled durably|headlessly|fixed Desktop/ });
    await user.screenshot();
    await user.click({ role: "button", label: /Daily project summary/ });
    await user.see({ text: "Runs on your desktop computer. Keep OpenWork open and connected at the scheduled time." });
    evidence.recordAssertionEvidence("Automation placement is visible and understandable", "The automation list labels its desktop computer; the detail explains that OpenWork must stay open and connected without runtime terminology.", true);
  });
});
