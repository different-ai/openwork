import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { spec, resolveEvalEngine, readTranscriptMessages } from "@openwork/testkit";
import { engineLiveDesktop } from "../worlds/engine-live-desktop.ts";
import { record } from "../worlds/engine-live-parity.ts";

const test = spec.world(engineLiveDesktop, { timeout: 600_000,
  resources: { surfaces: ["desktop"], services: [], nativeReason: "Exercise production first launch without any pre-created workspace or preferences." },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});
test(`LIVE-DESKTOP ${resolveEvalEngine()}: a blank installation creates its workspace and sends to the real starter model`, async ({ world, user, probe, step, evidence }) => {
  await step("The app creates its default workspace and opens an empty signed-out conversation", async () => {
    await user.see("composer", { editable: true, timeoutMs: 90_000 });
    await user.notSee({ text: "Welcome to OpenWork" });
    expect(await probe.storage("openwork.den.authToken")).toBeNull();
    const workspaces = (await world.request("/workspaces")).body;
    expect(workspaces).toMatchObject({ items: [expect.objectContaining({ path: expect.stringMatching(/OpenWork Chat$/) })] });
    await user.screenshot();
  });
  await step("The first task uses the actual starter service", async () => {
    await probe.eventually(() => probe.composer(), { within: 90_000, label: "starter model ready", until: state => !state.modelUnavailable });
    const marker = `LIVE-${randomUUID()}`;
    await user.type("composer", `Reply with exactly ${marker}. Do not use tools.`);
    await user.click("Run task");
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const messages = (await world.messages()).filter(record).map(message => record(message.info) ? message.info : message);
      const failure = messages.find(message => message.error);
      if (failure) {
        evidence.recordJsonArtifact("Actual provider rejection", { engine: world.engine, error: failure.error });
        await user.screenshot();
        throw new Error(`Real starter inference failed: ${JSON.stringify(failure.error)}`);
      }
      if (JSON.stringify(await readTranscriptMessages(probe, "assistant")).includes(marker)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    expect(JSON.stringify(await readTranscriptMessages(probe, "assistant"))).toContain(marker);
    await user.screenshot();
  });
});
