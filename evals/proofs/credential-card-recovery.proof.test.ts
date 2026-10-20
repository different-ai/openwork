import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { credentialCardRecovery } from "../worlds/credential-card-recovery.ts";

const test = spec.world(credentialCardRecovery, { timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] } });
const cards = '[data-testid="credential-prompt-card"]';

test("an admin completes two trusted setup requests without losing safe identifiers or having results take focus", async ({ world, user, probe, step, evidence }) => {
  await step("after: both trusted setup requests appear while the member keeps typing in chat", async () => {
    await user.click({ text: world.session.title });
    await user.reload();
    await user.type("composer", "Keep my setup notes.");
    world.releaseHistory();
    await user.see({ text: "Add the credentials for Project provider" }, { timeoutMs: 45_000 });
    await user.see({ text: "Add the API key for Project status" });
    const found = (await probe.dom(cards)).elements;
    const focused = (await probe.dom('[data-lexical-editor="true"]')).elements.some((element) => element.focused);
    expect(found).toHaveLength(2); expect(focused).toBe(true);
    evidence.recordAssertionEvidence("Two validated targets render once each without stealing composer focus", `credential cards: ${found.length}; composer focused: ${focused}`, found.length === 2 && focused);
    await user.screenshot();
    await user.type("composer", "", { replace: true });
  });
  await step("a missing private field keeps the safe access key identifier and asks only for what is missing", async () => {
    await user.type({ label: "Access key ID" }, "AKIAFIXTURE");
    await user.click({ role: "button", label: "Save credentials" });
    await user.see({ text: "Enter the secret access key." });
    await user.see({ label: "Access key ID" }, { value: "AKIAFIXTURE" });
    const counts = world.counts();
    expect(counts.providerSaves).toBe(0);
    evidence.recordAssertionEvidence("Local validation keeps the safe identifier and sends no credentials", `provider saves: ${counts.providerSaves}; safe identifier remains AKIAFIXTURE`, counts.providerSaves === 0);
    await user.screenshot();
  });
  await step("a rejected credential clears the private field but keeps the safe identifier for recovery", async () => {
    await user.type({ label: "Secret access key" }, "synthetic-private-rejected", { sensitive: true });
    await user.click({ role: "button", label: "Save credentials" });
    await user.see({ text: "Project provider didn't accept this key. Check it and try again." });
    await user.see({ label: "Access key ID" }, { value: "AKIAFIXTURE" });
    const privateField = await probe.credentialInputState(`${cards}[data-credential-prompt="gateway_provider_credential"] input[type="password"]`, "synthetic-private-rejected");
    expect(privateField.empty).toBe(true); expect(privateField.bodyContainsSecret).toBe(false);
    expect(world.counts().continuations).toBe(0);
    evidence.recordAssertionEvidence("Rejected private data is cleared, never copied into chat, and does not resume the task", `private field empty: ${privateField.empty}; transcript leak: ${privateField.bodyContainsSecret}; continuations: ${world.counts().continuations}`, privateField.empty && !privateField.bodyContainsSecret && world.counts().continuations === 0);
    await user.screenshot();
  });
  await step("saving one target leaves the second request pending and the parent task paused", async () => {
    await user.type({ label: "Secret access key" }, "synthetic-private-accepted", { sensitive: true });
    await user.click({ role: "button", label: "Save credentials" });
    await user.see({ text: "Project provider: credentials saved" });
    await user.see({ text: "Add the API key for Project status" });
    const counts = world.counts();
    expect(counts.continuations).toBe(0); expect(counts.providerSaves).toBe(2);
    evidence.recordAssertionEvidence("A partially fulfilled script does not resume early", `provider save attempts: ${counts.providerSaves}; connection saves: ${counts.connectionSaves}; continuations: ${counts.continuations}`, counts.providerSaves === 2 && counts.connectionSaves === 0 && counts.continuations === 0);
    await user.screenshot();
  });
  await step("the parent resumes once after the remaining required credential is saved", async () => {
    await user.type({ label: "API key" }, "synthetic-private-status", { sensitive: true });
    await user.click({ role: "button", label: "Save key" });
    await user.see({ text: world.answer }, { timeoutMs: 90_000 });
    const counts = world.counts();
    expect(counts.connectionSaves).toBe(1); expect(counts.continuations).toBe(1);
    evidence.recordAssertionEvidence("The final required save resumes the parent exactly once", `connection saves: ${counts.connectionSaves}; continuations: ${counts.continuations}`, counts.connectionSaves === 1 && counts.continuations === 1);
    await user.screenshot();
  });
});
