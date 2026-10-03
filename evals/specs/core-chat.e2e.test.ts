import { spec } from "@openwork/testkit";
import { coreWebWorld } from "../worlds/core-web.ts";

// Core PR journey. CI runs it on every non-docs PR (see CORE_SPECS in
// .github/scripts/pr-proof.mjs); its end-state checkpoint is the PR preview.
const test = spec.world(coreWebWorld, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { placement: "local", env: ["FREESTYLE_API_KEY"] },
  timeout: 900_000,
});

const PROMPT = "Say hello";
const REPLY = "Acme AI Gateway is working.";

test("CORE-CHAT: a signed-in person opens the app, sends a message, and reads the reply", { timeout: 900_000, tags: ["checkpoints"] }, async ({ user, step, evidence }) => {
  await step("the app opens on an editable composer", async () => {
    await user.see("composer", { editable: true });
    await user.screenshot();
    evidence.recordAssertionEvidence("The app opens ready to use", "This commit's web app loaded signed in, with an editable composer.", true);
  });

  await step("the person sends a message and reads the model's reply", async () => {
    await user.type("composer", PROMPT);
    await user.click("Run task");
    await user.see({ text: PROMPT });
    await user.see({ text: REPLY }, { timeoutMs: 120_000 });
    await user.see("composer", { editable: true });
    await user.screenshot();
    evidence.recordAssertionEvidence("A chat round-trip works", `The sent message and the model's reply ("${REPLY}") are on screen, and the composer is editable again.`, true);
  });
});
