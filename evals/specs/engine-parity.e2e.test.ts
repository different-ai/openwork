import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { readTranscriptMessages, resolveEvalEngine, spec } from "@openwork/testkit";
import { engineParity } from "../worlds/engine-parity.ts";

const test = spec.world(engineParity, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

test(`PARITY-STREAM ${resolveEvalEngine()}: read the beginning of an answer before the model finishes`, async ({ world, user, probe, step, evidence }) => {
  await probe.eventually(() => probe.composer(), { within: 60_000, label: "starter model ready", until: (state) => state.selectedModelLabel.includes("Big Pickle") && !state.modelUnavailable });
  const prompt = `Explain the next steps. STREAM-${randomUUID()}`;
  const chunks = [`First visible sentence ${randomUUID()}. `, `Final sentence ${randomUUID()}.`];
  await world.prepareStream(prompt, chunks);
  await step("The user message and first sentence render while the rest is held upstream", async () => {
    await user.type("composer", prompt);
    const started = performance.now();
    await user.click("Run task");
    await user.see({ text: prompt }, { timeoutMs: 10_000 });
    const userRenderedMs = performance.now() - started;
    try {
      await user.see({ text: chunks[0].trim() }, { timeoutMs: 15_000 });
      const firstTextMs = performance.now() - started;
      const upstream = await world.mock.agentReplyState(prompt);
      expect(upstream.complete).toBe(false);
      expect(upstream.deliveredChunks).toBe(1);
      await user.notSee({ text: chunks[1] });
      await user.screenshot();
      evidence.recordJsonArtifact("Visible streaming while upstream is paused", { engine: world.engine, userRenderedMs, firstTextMs, upstream });
    } finally { await world.mock.releaseAgentReply(prompt); }
  });
  await step("Releasing the remaining sentence completes the same answer once", async () => {
    await user.see({ text: chunks.join("") }, { timeoutMs: 30_000 });
    await user.see("Run task");
    expect(await readTranscriptMessages(probe, "user")).toHaveLength(1);
    expect(await readTranscriptMessages(probe, "assistant")).toHaveLength(1);
    await user.screenshot();
  });
});

test(`PARITY-SKILLS ${resolveEvalEngine()}: ${resolveEvalEngine() === "v2" ? "install, edit, remove and reinstall a skill in one conversation" : "install a skill and use its instructions"}`, async ({ world, user, probe, step, evidence }) => {
  await user.see("composer", { editable: true });
  await probe.eventually(() => probe.composer(), { within: 60_000, label: "starter model ready", until: (state) => state.selectedModelLabel.includes("Big Pickle") && !state.modelUnavailable });
  const document = await world.documentIdentity();
  const runtime = await world.runtime();
  const workspace = /\/workspace\/([^/]+)\/session/.exec(await world.route())?.[1];
  if (!workspace) throw new Error("The fresh app did not open a workspace");
  const skillName = "parity-release-briefing";
  const skillPath = `/workspace/${workspace}/skills`;
  let route = "";
  const priorCodes: string[] = [];
  let turns = 0;
  async function waitForSkill(expected: string | null) {
    await probe.eventually(async () => {
      const response = await world.request(`/workspace/${workspace}/${world.engine === "v2" ? "opencode2/api" : "opencode"}/skill`);
      const payload = response.body;
      const skills = Array.isArray(payload) ? payload : payload && typeof payload === "object" && "data" in payload && Array.isArray(payload.data) ? payload.data : [];
      return skills.find((skill: unknown) => skill && typeof skill === "object" && "name" in skill && skill.name === skillName);
    }, { within: 15_000, label: "native skill catalog reflects the installed files", until: (skill) => expected ? JSON.stringify(skill)?.includes(expected) === true : skill === undefined });
  }
  async function ask(expected: string | null) {
    await waitForSkill(expected);
    const before = await readTranscriptMessages(probe, "assistant");
    const prompt = `Read the current amber release instructions. Use fresh instructions, or say UNAVAILABLE. Request ${++turns}.`;
    await world.prepareTurn(prompt, "UNAVAILABLE", world.engine === "v2"
      ? [{ tool: "skill", argumentsFrom: "skill-catalog", arguments: { skill: skillName } }]
      : [{ tool: "skill", arguments: { name: skillName } }], "last-tool-text");
    await user.type("composer", prompt);
    await user.click("Run task");
    await user.see({ text: prompt });
    const answer = await probe.eventually(() => readTranscriptMessages(probe, "assistant"), {
      within: 90_000, label: `turn ${turns} uses only the current skill content`,
      until: (messages) => messages.length > before.length && (expected
        ? Boolean(messages.at(-1)?.includes(expected)) : /UNAVAILABLE|not found|not available|Unable to load skill/i.test(messages.at(-1) ?? "")),
    }).catch(async (error: unknown) => {
      evidence.recordJsonArtifact("Failed skill turn", { turns, calls: await world.mock.agentRequests(), screen: await probe.text(), runtime: await world.runtime() });
      await user.screenshot();
      throw error;
    });
    await user.see("Run task");
    for (const code of priorCodes) expect(answer.at(-1)).not.toContain(code);
    // The transcript virtualizes older turns; persistence, not simultaneous
    // DOM presence, proves that the conversation has kept every user message.
    const sessionId = (await world.route()).split("/").at(-1);
    const messages = await world.request(`/workspace/${workspace}/${world.engine === "v2" ? "opencode2/api" : "opencode"}/session/${sessionId}/message`);
    const payload = messages.body;
    const rows: unknown[] = Array.isArray(payload) ? payload : payload && typeof payload === "object" && "data" in payload && Array.isArray(payload.data) ? payload.data : [];
    expect(rows.filter((row) => row && typeof row === "object" && ("type" in row && row.type === "user" || "info" in row && row.info && typeof row.info === "object" && "role" in row.info && row.info.role === "user"))).toHaveLength(turns);
    if (route) expect(await world.route()).toBe(route);
    route = await world.route();
    expect(await world.documentIdentity()).toBe(document);
    if (world.engine === "v2") expect((await world.runtime()).pid).toBe(runtime.pid);
    await user.screenshot();
  }
  const install = async (code: string) => {
    expect((await world.request(skillPath, "POST", {
      name: skillName, description: "Current amber release instructions.", content: `The current amber release code is ${code}.`,
    })).status).toBe(200);
    if (world.engine === "v1") await step("Apply the skill change through v1's legacy engine reload", async () => {
      expect((await world.request(`/workspace/${workspace}/engine/reload`, "POST")).status).toBe(200);
    });
  };
  if (world.engine === "v1") {
    await step("Install a skill before the first task, apply the legacy reload, and use its real instructions", async () => {
      const code = randomUUID();
      await install(code);
      await ask(code);
    });
    evidence.recordAssertionEvidence("V1 skill consumption baseline", "The answer contains a random code read by the native skill tool from the installed file. V2 additionally proves updates in an existing conversation without any reload.", true);
    return;
  }
  await step("Before installation, the app cannot invent the skill's answer", () => ask(null));
  for (const label of ["Install a new skill", "Edit its content while the conversation stays open"]) {
    await step(label, async () => {
      const code = randomUUID();
      await install(code);
      await ask(code);
      priorCodes.push(code);
    });
  }
  await step("Remove the skill and stop using its old instructions", async () => {
    expect((await world.request(`${skillPath}/${skillName}`, "DELETE")).status).toBe(200);
    await ask(null);
  });
  await step("Reinstall it with new instructions without restarting the conversation", async () => {
    const code = randomUUID();
    await install(code);
    await ask(code);
  });
  evidence.recordJsonArtifact("Engine reload requests during skill changes", { engine: world.engine, requests: await world.reloadRequests() });
  if (world.engine === "v2") expect(await world.reloadRequests()).toEqual([]);
  evidence.recordAssertionEvidence("Five skill lifecycle turns in the same app document and conversation", "Answers came from real native skill tool results. Random codes existed only in installed files, never in the prompt or canned model answer. V2 retained its original engine PID and received no reload requests.", true);
});

test(`PARITY-BOOT ${resolveEvalEngine()}: open the app and send with its first available model`, async ({ world, user, probe, step, evidence }) => {
  const document = await world.documentIdentity();
  const runtime = await world.runtime();
  expect(runtime.chatRouting).toBe(world.engine === "v2");
  let composerReadyMs = 0;
  await step("A fresh signed-out app chooses Big Pickle without model setup", async () => {
    await user.see("composer", { editable: true, text: "" });
    await probe.eventually(() => probe.composer(), {
      within: 60_000, label: "the available starter model selected automatically",
      until: (state) => state.selectedModelLabel.includes("Big Pickle") && !state.modelUnavailable,
    });
    composerReadyMs = performance.now() - world.startedAt;
    expect(await probe.storage("openwork.den.authToken")).toBeNull();
    expect(await world.mock.agentRequests()).toEqual([]);
    await user.screenshot();
  });
  await step("Type a normal task and see the first answer in the conversation", async () => {
    await user.type("composer", world.prompt);
    await probe.eventually(() => probe.composer(), { within: 15_000, label: "first send enabled", until: (state) => state.runTaskEnabled });
    const sendAt = performance.now();
    await user.click("Run task");
    await user.see({ text: world.prompt }, { timeoutMs: 15_000 });
    const userRenderedMs = performance.now() - sendAt;
    await user.see({ text: world.reply }, { timeoutMs: 90_000 });
    const completedMs = performance.now() - sendAt;
    await user.see("Run task", { timeoutMs: 30_000 });
    const requests = await world.mock.agentRequests({ promptMarker: world.prompt });
    expect(requests.filter((request) => request.kind === "final")).toHaveLength(1);
    expect(requests.every((request) => request.model === "big-pickle")).toBe(true);
    expect((await probe.composer()).userMessageCount).toBe(1);
    expect(await world.documentIdentity()).toBe(document);
    if (world.engine === "v2") expect((await world.runtime()).pid).toBe(runtime.pid);
    const timings = { engine: world.engine, engineVersion: world.engineVersion, sourceSha: world.app.actualSourceSha, build: "development app-web working tree, fresh profile, shared package cache", interactiveMs: world.interactiveMs, composerReadyMs, userRenderedMs, completedMs };
    evidence.recordJsonArtifact("App launch and first answer timings", timings);
    console.info(`PARITY_TIMING ${JSON.stringify(timings)}`);
    await user.screenshot();
  });
});
