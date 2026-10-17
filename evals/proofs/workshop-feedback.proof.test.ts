import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workshopFeedbackUi } from "../worlds/workshop-feedback-ui.ts";
const test = spec.world(workshopFeedbackUi, { timeout: 180000, resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" } });
const note = "Not helpful: the missing-policy uncertainty and next step were not clear enough.\n\nReference: session feedback-regression; response actual-ui-mechanism-proof.";

test("a person submits negative feedback through the existing form and its backend persists the note", { timeout: 240000 }, async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: the real feedback form has not persisted a note", async () => {
    await user.navigate(world.url + "?source=openwork-app&entrypoint=status-bar");
    await user.see({ placeholder: "What were you trying to do? What did you expect? What actually happened?" });
    await world.waitForForm();
    const state = await world.read();
    expect(state.threads).toHaveLength(0);
    evidence.recordAssertionEvidence("No feedback is seeded", "The existing form is visible and the owned provider has zero threads", state.threads.length === 0);
    await user.screenshot();
  });
  await step("the person types a negative note and submits the real form", async () => {
    await user.type({ placeholder: "Jane Doe" }, "Alex Chen");
    await user.type({ placeholder: "jane@company.com" }, "alex@acme.test");
    await user.type({ placeholder: "What were you trying to do? What did you expect? What actually happened?" }, note, { intervalMs: 20 });
    await user.see({ placeholder: "Jane Doe" }, { value: "Alex Chen" });
    await user.see({ placeholder: "jane@company.com" }, { value: "alex@acme.test" });
    await user.see({ placeholder: "What were you trying to do? What did you expect? What actually happened?" }, { value: note });
    await user.screenshot();
    await user.click({ role: "button", label: "Send feedback" });
    await user.see({ text: "Feedback sent" }, { timeoutMs: 45000 });
    evidence.recordAssertionEvidence("The existing route accepted the submitted form", "The product shows Feedback sent after the trusted UI submission", await probe.has("Feedback sent"));
    await user.screenshot();
  });
  await step("after: actual provider transport and disk readback contain exactly the submitted note", async () => {
    const state = await world.read();
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0].input.components.map((component) => component.componentPlainText.plainText).join("\n")).toContain(note);
    expect(state.customers[0].email).toBe("alex@acme.test");
    evidence.recordAssertionEvidence("The note is actually persisted", `Owned Plain thread ${state.threads[0].id}; authenticated HTTP and independent disk readbacks agree`, state.threads.length === 1 && state.threads[0].input.components.map((component) => component.componentPlainText.plainText).join("\n").includes(note));
    await user.see({ text: "Feedback sent" });
    await user.screenshot();
  });
});
