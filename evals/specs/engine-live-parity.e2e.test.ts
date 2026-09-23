import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { spec, resolveEvalEngine, readTranscriptMessages } from "@openwork/testkit";
import { engineLiveParity, record } from "../worlds/engine-live-parity.ts";

const test = spec.world(engineLiveParity, { timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: [] },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

test(`LIVE-FRESH ${resolveEvalEngine()}: create the first workspace and send to the real free model`, async ({ world, user, probe, step, evidence }) => {
  await step("A completely fresh profile has no workspace", async () => {
    const listing = await world.request("/workspaces");
    expect(listing.status).toBe(200);
    expect(record(listing.body) ? listing.body.items : null).toEqual([]);
    await user.screenshot();
  });
  await step("The browser offers workspace setup; create a local folder through the real host API", async () => {
    await user.click({ role: "button", label: "Use Without Cloud" });
    await user.screenshot();
    // The browser deliberately disables the native folder chooser. This is not
    // evidence for the Electron directory-picker interaction.
    const created = await world.request("/workspaces/local", "POST", { folderPath: world.workspacePath, name: "Live parity", preset: "starter" });
    expect(created.status).toBe(201);
    await user.navigate(`${world.app.webUrl}/session`);
    await user.see("composer", { editable: true, timeoutMs: 90_000 });
    await probe.eventually(() => probe.composer(), { within: 90_000, label: "first available model enables sending", until: state => !state.modelUnavailable && Boolean(state.selectedModelLabel) });
    await user.screenshot();
  });
  await step("Send a nonce challenge to the real model and observe its generated answer", async () => {
    const nonce = randomUUID();
    const model = (await probe.composer()).selectedModelLabel;
    const started = Date.now();
    await user.type("composer", `Reply with exactly LIVE-${nonce}. Do not use tools.`);
    await user.click("Run task");
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const messages = await world.messages();
      const failure = messages.filter(record).map(message => record(message.info) ? message.info : message).find(message => message.error);
      if (failure) {
        evidence.recordJsonArtifact("Real provider failure", { engine: world.engine, model, error: failure.error });
        await user.screenshot();
        throw new Error(`Real ${model} inference failed: ${JSON.stringify(failure.error)}`);
      }
      if (JSON.stringify(await readTranscriptMessages(probe, "assistant")).includes(`LIVE-${nonce}`)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    expect(JSON.stringify(await readTranscriptMessages(probe, "assistant"))).toContain(`LIVE-${nonce}`);
    await user.see("Run task", { timeoutMs: 30_000 });
    evidence.recordJsonArtifact("Real first-model response", { engine: world.engine, model, elapsedMs: Date.now() - started, assistant: await readTranscriptMessages(probe, "assistant") });
    await user.screenshot();
  });
});
