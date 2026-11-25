import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { coreWebCredentials, coreWebWorld } from "../worlds/core-web.ts";

// Core journey on a Freestyle world. CI runs it nightly ("Freestyle world
// check") and in PR change proof (see CORE_SPECS in .github/scripts/pr-proof.mjs);
// its end-state checkpoint is the PR preview.
const test = spec.world(coreWebWorld, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { placement: "local", env: coreWebCredentials() },
  timeout: 900_000,
});

const PROMPT = "Say hello";
// The world's deterministic model answers every prompt with this reply.
const REPLY = "Acme AI Gateway is working.";
// Typed key by key with no click first, so keep it short and space-free.
const FOLLOWUP = "again";
// A prompt that starts with a path containing a space must reach the model as text.
const PATH_PROMPT = "/Applications/Open Coworker.app what is this app?";

test("CHAT-ROUNDTRIP: a signed-in person sends a message and reads the reply", { timeout: 900_000, tags: ["checkpoints"] }, async ({ user, probe, step, evidence }) => {
  await step("the app opens on an editable composer", async () => {
    await user.see("composer", { editable: true });
    await user.screenshot();
  });

  let sessionRoute = "";
  await step("the person sends a message, the composer clears, and the model's reply arrives", async () => {
    await user.type("composer", PROMPT);
    await user.click("Run task");
    await user.see({ text: PROMPT });
    await user.see("composer", { text: "", timeoutMs: 10_000 });
    await user.see({ text: REPLY }, { timeoutMs: 120_000 });
    await user.see("composer", { editable: true });
    sessionRoute = await probe.eventually(() => probe.hash(), {
      within: 60_000, label: "the conversation opens on its own session route", until: (route) => /\/session\/ses_[^/]+$/.test(route),
    });
    await user.screenshot();
  });

  await step("the composer already has the keyboard, so a follow-up typed without clicking is sent in the same conversation", async () => {
    const focus = await probe.eventually(async () => (await probe.dom("[data-lexical-editor='true'][contenteditable='true']")).elements, {
      within: 10_000, label: "the composer is focused after the reply", until: (editors) => editors.some((editor) => editor.focused),
    });
    expect(focus.some((editor) => editor.focused)).toBe(true);
    // Deliberately no click: each key goes to whatever already has focus.
    for (const key of FOLLOWUP) await user.press(key);
    await user.see("composer", { text: FOLLOWUP });
    await user.press("Enter");
    const state = await probe.eventually(() => probe.composer(), {
      within: 120_000, label: "the follow-up is answered", until: (value) => value.userMessageCount === 2 && value.assistantMessageCount >= 2,
    });
    expect(state.userMessageCount).toBe(2);
    expect(await probe.hash()).toBe(sessionRoute);
    evidence.recordAssertionEvidence("A follow-up typed without clicking stays in the conversation",
      `${state.userMessageCount} user and ${state.assistantMessageCount} assistant messages on ${sessionRoute}`, state.userMessageCount === 2);
  });

  await step("a message that starts with a path containing a space is sent as text and answered, not read as a missing file", async () => {
    await user.type("composer", PATH_PROMPT, { verify: true });
    await user.click("Run task");
    await user.see({ text: PATH_PROMPT });
    const state = await probe.eventually(() => probe.composer(), {
      within: 120_000, label: "the path prompt is answered", until: (value) => value.userMessageCount === 3 && value.assistantMessageCount >= 3,
    });
    expect(state.assistantMessageCount).toBeGreaterThanOrEqual(3);
    await user.notSee({ text: "File not found" });
    await user.notSee({ text: "Did you mean" });
    await user.screenshot();
  });
});
