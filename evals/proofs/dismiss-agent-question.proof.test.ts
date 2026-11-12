import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { isRecord } from "../worlds/library.ts";
import { childDecisionsWeb } from "../worlds/child-decisions.ts";

const test = spec.world(childDecisionsWeb, { timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] } });

test("a member dismisses an agent question they do not want to answer", async ({ world, user, probe, step }) => {
  const pending = async () => {
    const response = await world.nativePendingDecisions();
    expect(response.status).toBe(200);
    const data = isRecord(response.body) && "data" in response.body ? response.body.data : response.body;
    if (!Array.isArray(data)) throw new Error("Native pending decisions did not return a list");
    return data.filter(isRecord).map(item => ({ id: item.id, sessionID: item.sessionID }));
  };
  await step("before: the agent asks a question above the composer", async () => {
    await user.reload();
    await user.type("composer", world.unrelated.prompt, { verify: true });
    await probe.eventually(() => probe.composer(), { within: 30_000, label: "the configured engine admits the request", until: state => state.runTaskEnabled });
    await user.click("Run task");
    await user.see({ text: world.unrelated.question }, { timeoutMs: 60_000 });
    expect(await pending()).toEqual([expect.objectContaining({ sessionID: world.unrelated.sessionId })]);
    await user.see({ role: "button", label: "Dismiss" });
    await user.screenshot();
  });
  await step("after: Dismiss clears the question without answering it", async () => {
    await user.click({ role: "button", label: "Dismiss" });
    await probe.eventually(pending, { within: 60_000, label: "the engine no longer waits on the question", until: items => items.length === 0 });
    await user.notSee({ text: world.unrelated.question });
    await user.see("composer", { editable: true });
    await user.screenshot();
  });
});
