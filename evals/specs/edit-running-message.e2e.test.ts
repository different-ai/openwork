import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { readTranscriptMessages, resolveEvalEngine, spec } from "@openwork/testkit";
import { engineParity } from "../worlds/engine-parity.ts";

const test = spec.world(engineParity, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Native engines own abort, revert and history. Only model transport is synthetic;
// a held stream proves that the old turn cannot finish before the edit is sent.
test(`EDIT-BUSY ${resolveEvalEngine()}: replace a running message instead of queueing the edit`, async ({ world, user, probe, step, evidence }) => {
  await probe.eventually(() => probe.composer(), {
    within: 60_000, label: "starter model ready", until: state => state.selectedModelLabel.includes("Big Pickle") && !state.modelUnavailable,
  });
  await user.type("composer", world.prompt);
  await user.click("Run task");
  await user.see({ text: world.reply });
  await user.see("Run task");
  const route = await world.route();
  const workspaceId = /\/workspace\/([^/]+)\/session/.exec(route)?.[1];
  const sessionId = route.split("/").at(-1);
  if (!workspaceId || !sessionId) throw new Error("Expected a saved conversation");
  const nativePath = `/workspace/${workspaceId}/${world.engine === "v2" ? "opencode2/api" : "opencode"}/session/${sessionId}`;
  const expectedUsers = [world.prompt];

  for (const submission of ["Enter", "button"]) {
    const original = `Review the initial draft ${randomUUID()}`;
    const partial = `Review in progress ${randomUUID()}. `;
    const neverReleased = `Unfinished answer ${randomUUID()}.`;
    const edited = `Review the corrected draft ${randomUUID()}`;
    const answer = `Corrected review ${randomUUID()}`;
    // Configure both workloads before starting: replacing the mock configuration
    // during a held stream would itself abort the stream and invalidate this proof.
    const configured = await fetch(`${world.mock.url}/admin/agent-workloads`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workloads: [
        { promptMarker: original, latestUserTurn: true, steps: [], finalReply: partial + neverReleased,
          finalReplyChunks: [partial, neverReleased], finalReplyInitiallyReleasedChunks: 1 },
        { promptMarker: edited, latestUserTurn: true, steps: [], finalReply: answer },
      ] }),
    });
    expect(configured.ok).toBe(true);
    await step(`Edit a running turn and submit with ${submission}`, async () => {
      await user.type("composer", original);
      await user.click("Run task");
      await user.see({ text: partial.trim() }, { timeoutMs: 30_000 });
      await user.see("Stop");
      expect((await world.mock.agentReplyState(original)).complete).toBe(false);
      await user.hover({ text: original });
      await user.click({ role: "button", label: "Edit message", nth: expectedUsers.length });
      await user.see("composer", { text: original });
      await user.type("composer", edited, { replace: true, verify: true });
      await user.screenshot();
      if (submission === "Enter") await user.press("Enter");
      else await user.click("Run task");
      await user.notSee({ text: "1 queued" });
      await user.see({ text: answer }, { timeoutMs: 45_000 });
      await user.see("Run task");
      await user.notSee({ text: original });
      await user.notSee({ text: neverReleased });
      await user.see({ text: world.reply });
      expect(await world.route()).toBe(route);
      expectedUsers.push(edited);
      expect(await readTranscriptMessages(probe, "user")).toEqual(expectedUsers.map(text => expect.stringContaining(text)));
      const response = await world.request(`${nativePath}/message`);
      expect(response.status).toBe(200);
      const body = response.body;
      const messages: unknown[] = Array.isArray(body) ? body : record(body) && Array.isArray(body.data) ? body.data : [];
      const users = messages.filter(row => record(row) && (row.type === "user" || record(row.info) && row.info.role === "user"));
      expect(users).toHaveLength(expectedUsers.length);
      expect(JSON.stringify(users)).toContain(edited);
      expect(JSON.stringify(users)).not.toContain(original);
      await user.screenshot();
    });
  }

  await step("An ordinary follow-up still waits in the queue", async () => {
    const original = `Keep this turn running ${randomUUID()}`;
    const chunks = [`Still working ${randomUUID()}. `, `Finished ${randomUUID()}.`];
    await world.prepareStream(original, chunks);
    await user.type("composer", original);
    await user.click("Run task");
    await user.see({ text: chunks[0].trim() });
    await user.see("Stop");
    const followup = `A later follow-up ${randomUUID()}`;
    await user.type("composer", followup);
    await user.press("Enter");
    await user.see({ text: "1 queued" });
    expect((await probe.composer()).draftText).toBe("");
    expect((await world.mock.agentReplyState(original)).complete).toBe(false);
    expect((await readTranscriptMessages(probe, "user")).some(text => text.includes(followup))).toBe(false);
    await user.screenshot();
    // Stop owns the held stream; this fixture does not release it behind the UI.
    await user.click("Stop");
  });
  evidence.recordAssertionEvidence("Running edits replace their native history boundary", "Enter and the send button abort a held native turn, replace only that turn, preserve earlier history, and never queue the replacement. A normal follow-up still queues.", true);
});
