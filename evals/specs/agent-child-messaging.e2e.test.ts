import { expect } from "vitest";
import { resolveEvalEngine, spec } from "@openwork/testkit";
import { observeSessionCommands } from "../helpers/observe-session-commands.ts";
import { agentChildWeb } from "../worlds/agent-child.ts";
import { isRecord } from "../worlds/library.ts";

const test = spec.world(agentChildWeb, { timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["mock"] } });

test(`a member messages a busy helper and returns without losing its draft (AGENT-CHILD-01 ${resolveEvalEngine()})`, async ({ world, user, probe, step, evidence }) => {
  await using commands = await observeSessionCommands(probe);
  await step("before: the main chat delegates a fixture review", async () => {
    await user.type("composer", world.prompt, { verify: true });
    await probe.eventually(() => probe.composer(), { within: 30_000, label: "the configured engine admits the first prompt", until: state => state.runTaskEnabled });
    await user.click("Run task");
    await user.see({ text: "Review fixture" }, { timeoutMs: 60_000 }).catch(async error => {
      evidence.recordJsonArtifact("Delegation startup diagnostics", { screen: await probe.text(), commands: await commands.read(),
        modelRequests: await world.mock.agentRequests({ atLeast: 0 }), nativeSession: await world.nativeSession(world.session.sessionId),
        nativeTools: await world.delegatedTools() });
      await user.screenshot();
      throw error;
    });
    evidence.recordAssertionEvidence("Delegation is visible in its original turn", "The admitted parent prompt exposes the Review fixture child in the existing live rail.", true);
    await user.screenshot();
  });
  await step("the child displays its original brief and keeps its own composer", async () => {
    await user.click({ role: "button", label: "Review fixture. Open sub-agent chat" });
    await user.click({ role: "button", label: "Original task" });
    await user.see({ text: world.childPrompt });
    await user.see({ text: "Check fixture output" }, { timeoutMs: 60_000 });
    await user.screenshot();
    evidence.recordJsonArtifact("Native delegated child tools", await world.delegatedTools());
    await probe.eventually(() => world.grandchildState(), { within: 60_000, label: "grandchild holds its live reply", until: state => state.deliveredChunks === 1 });
    evidence.recordAssertionEvidence("The child exposes its original delegated brief", "Opening the child displays its brief and own composer while the grandchild holds exactly one reply chunk.", true);
    await user.screenshot();
  });
  await step("Enter admits a message to the child and issues no abort", async () => {
    const childId = await world.selectedSessionId();
    if (!childId) throw new Error("The selected helper did not expose its conversation identity");
    expect(childId).not.toBe(world.session.sessionId);
    const nativeChild = await world.nativeSession(childId);
    expect(isRecord(nativeChild) && "data" in nativeChild ? nativeChild.data : nativeChild).toMatchObject({ parentID: world.session.sessionId });
    await user.type("composer", world.followup, { verify: true });
    await user.press("Enter");
    await user.see({ text: world.followup });
    const requests = await probe.eventually(() => commands.read(), { within: 15_000,
      label: "the busy helper receives its own prompt admission",
      until: requests => requests.some(request => request.path.includes(`/session/${childId}/`) && /\/prompt(?:_async)?$/.test(request.path)),
    });
    evidence.recordJsonArtifact("Scoped command transport", requests);
    expect(requests.filter(request => /\/(?:abort|interrupt)$/.test(request.path))).toEqual([]);
    const state = await world.grandchildState();
    expect(state.deliveredChunks).toBe(1);
    expect(state.complete).toBe(false);
    evidence.recordAssertionEvidence("the busy helper really receives the follow-up", `A prompt POST targets the selected helper with 0 aborts; the grandchild remains at ${state.deliveredChunks} chunk and complete=${state.complete}.`, true);
  });
  await step("Escape returns to the originating card and preserves the child's unsent draft", async () => {
    await user.type("composer", "Ask about the fixture provenance", { verify: true });
    await user.press("Escape");
    await user.see({ role: "button", label: "Review fixture. Open sub-agent chat" });
    expect((await probe.composer()).draftText).not.toContain("fixture provenance");
    await user.click({ role: "button", label: "Review fixture. Open sub-agent chat" });
    await probe.eventually(() => probe.composer(), { within: 10_000, label: "the child restores its scoped draft", until: state => state.draftText === "Ask about the fixture provenance" });
    expect((await commands.read()).filter(request => /\/(?:abort|interrupt)$/.test(request.path))).toEqual([]);
    evidence.recordAssertionEvidence("Return navigation preserves scoped drafts", "Escape returns to the original card; the parent excludes the child draft, and reopening restores its exact text with 0 aborts.", true);
  });
  await step("after: the grandchild and child finish and the result reaches the main chat", async () => {
    await world.releaseGrandchild();
    await user.see({ text: world.finalReply }, { timeoutMs: 90_000 });
    await user.press("Escape");
    await user.see({ text: "The delegated fixture review is ready." }, { timeoutMs: 90_000 });
    await user.see("Run task");
    evidence.recordAssertionEvidence("The child result reaches the main chat", "Releasing delegated work finishes the child; returning shows the parent review result and an idle composer.", true);
    await user.screenshot();
  });
});

test(`a member stops one helper from its parent chat (AGENT-CHILD-STOP ${resolveEvalEngine()})`, async ({ world, user, probe, step, evidence }) => {
  await using commands = await observeSessionCommands(probe);
  let childId = "";
  await step("before: delegated work is running and the parent still owns its own chat", async () => {
    await user.type("composer", world.prompt, { verify: true });
    await user.click("Run task");
    await user.see({ role: "button", label: "Review fixture. Open sub-agent chat" }, { timeoutMs: 60_000 }).catch(async error => {
      evidence.recordJsonArtifact("Delegation startup diagnostics", { screen: await probe.text(), commands: await commands.read(),
        modelRequests: await world.mock.agentRequests({ atLeast: 0 }), nativeSession: await world.nativeSession(world.session.sessionId),
        nativeTools: await world.delegatedTools() });
      await user.screenshot();
      throw error;
    });
    await user.click({ role: "button", label: "Review fixture. Open sub-agent chat" });
    // Opening a split pane leaves keyboard focus on the parent's opener.
    // Interact with the helper's own brief before observing its focused scope.
    await user.click({ role: "button", label: "Original task" });
    await user.see({ text: world.childPrompt });
    childId = await world.selectedSessionId();
    expect(childId).not.toBe("");
    expect(childId).not.toBe(world.session.sessionId);
    const nativeChild = await world.nativeSession(childId);
    expect(isRecord(nativeChild) && "data" in nativeChild ? nativeChild.data : nativeChild).toMatchObject({ parentID: world.session.sessionId });
    await user.see({ text: "Check fixture output" }, { timeoutMs: 60_000 });
    await probe.eventually(() => world.grandchildState(), { within: 60_000,
      label: "the delegated work is really held", until: state => state.deliveredChunks === 1 });
    await user.click("composer");
    await user.press("Escape");
    await user.see({ role: "button", label: "Review fixture. Stop sub-agent" });
    evidence.recordAssertionEvidence("the helper is really running", "Its grandchild has delivered one held chunk; the parent exposes a Stop for this helper", true);
    await user.screenshot();
  });
  await step("after: Stop interrupts the selected helper and reports acknowledgement", async () => {
    await user.click({ role: "button", label: "Review fixture. Stop sub-agent" });
    await user.see({ text: "Stopped" }, { timeoutMs: 30_000 });
    const interrupts = (await commands.read()).filter(request => /\/(?:abort|interrupt)$/.test(request.path));
    evidence.recordJsonArtifact("Acknowledged helper interruption targets", interrupts);
    const targets = [...new Set(interrupts.map(request => decodeURIComponent(request.path.split("/session/")[1]?.split("/")[0] ?? "")))];
    expect(targets).toContain(childId);
    expect(targets).not.toContain(world.session.sessionId);
    for (const target of targets.filter(id => id !== childId)) {
      const response = await world.nativeSession(target);
      const session = isRecord(response) && "data" in response ? response.data : response;
      expect(session).toMatchObject({ parentID: childId });
    }
    evidence.recordAssertionEvidence("Stop stays within the verified helper subtree", `${interrupts.length} interruption requests target only the selected helper and its verified child; none target the parent`, true);
    await user.screenshot();
  });
  await step("returning to the helper keeps navigation usable after Stop", async () => {
    await user.click({ role: "button", label: "Review fixture. Open sub-agent chat" });
    await user.click({ role: "button", label: "Original task" });
    expect(await world.selectedSessionId()).toBe(childId);
    await user.see("composer", { editable: true });
    await user.click("composer");
    await user.press("Escape");
    await user.see({ role: "button", label: "Review fixture. Open sub-agent chat" });
    evidence.recordAssertionEvidence("return still works after interruption", "The stopped helper and parent can still be opened using the same transcript control", true);
    await user.screenshot();
  });
});
