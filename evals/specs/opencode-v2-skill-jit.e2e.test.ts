import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { liveOpenAiEnabled } from "@openwork/behaviors";
import { browserScript, observeTranscript, readTranscriptMessages, spec, type Probe, type User } from "@openwork/testkit";
import { skillLifecycle } from "../worlds/chat.ts";
import { selectedSkillsWeb } from "../worlds/selected-skills.ts";
import {
  cloudNativeSkillIdPrefix,
  skillJitWeb,
  type SkillJitTurnTarget,
} from "../worlds/skill-jit.ts";

const test = spec.world(skillLifecycle, {
  timeout: 900_000,
  needs: liveOpenAiEnabled() ? { env: ["OPENAI_API_KEY"], daytona: true } : {},
});

// The engine is selected by the world. The journey does not inspect injected
// instructions, catalog formatting, native tool names, or engine message shapes.
test("workspace skills change during an ongoing conversation", async ({ world, user, agent, probe, step, evidence }) => {
  const runtime = await world.runtimeIdentity();
  const sessionRoute = await probe.hash();
  const skillRoute = `/workspace/${world.workspace.workspaceId}/skills`;
  const previousCodes: string[] = [];
  let turnNumber = 0;
  const submitted: string[] = [];
  const answer = async () => {
    const messages = await readTranscriptMessages(probe, "assistant");
    const id = await probe.eval(browserScript(() => [...document.querySelectorAll('[data-message-role="assistant"]')].at(-1)?.getAttribute("data-message-id") ?? "", []));
    const state = await world.conversationState();
    return { id, text: messages.at(-1) ?? "", messages, completed: state.completed.includes(id) };
  };
  const ask = async (expected: string | null) => {
    const before = await answer();
    const prompt = `What app are you? What is the current amber release report code? `
      + `Use the currently installed instructions; do not reuse an earlier code. `
      + `If no matching instructions are installed, say UNAVAILABLE. Request ${++turnNumber}.`;
    expect(prompt).not.toContain(world.skillName);
    expect(prompt).not.toContain("SKILL.md");
    for (const code of [...previousCodes, ...(expected ? [expected] : [])]) expect(prompt).not.toContain(code);
    await world.prepareTurn(prompt);
    await using transcript = await observeTranscript(probe, [{ role: "user", text: prompt }]);
    await user.see("composer", { editable: true });
    await user.type("composer", prompt, { verify: true }).catch(async (error: unknown) => {
      evidence.recordJsonArtifact("Skill conversation draft failure", { composer: await probe.composer(), screen: await probe.text() });
      await user.screenshot();
      throw error;
    });
    await user.press("Enter");
    await user.see({ text: prompt }, { timeoutMs: 15_000 });
    const response = await probe.eventually(answer, {
      within: 150_000, label: "the conversation answers using the currently installed instructions",
      until: (value) => record(value) && record(before) && value.id !== before.id && value.completed === true
        && typeof value.text === "string" && value.text.includes(expected ?? "UNAVAILABLE"),
    });
    await user.see("Run task", { timeoutMs: 60_000 });
    submitted.push(prompt);
    // Older groups leave the DOM as the conversation grows. Verify stored
    // history in full and keep the current turn's visible-message observer.
    const history = (await world.conversationState()).users;
    expect(history).toHaveLength(submitted.length);
    for (const sent of submitted) expect(history.filter(text => text.includes(sent))).toHaveLength(1);
    expect(await readTranscriptMessages(probe, "system")).toEqual([]);
    // A silent swap to an organization model must fail here, not as a text mismatch.
    expect(await world.usedConfiguredModel()).toBe(true);
    if (!record(response) || typeof response.text !== "string") throw new Error("Missing visible answer");
    for (const code of previousCodes) expect(response.text).not.toContain(code);
    expect(await transcript.finish()).toMatchObject({ seen: [true], violations: [], stopped: false });
    expect(await probe.hash()).toBe(sessionRoute);
    expect(await world.runtimeIdentity()).toBe(runtime);
    await user.screenshot();
    return response.text;
  };
  const install = async (code: string, description: string) => {
    const result = await agent.desktopApi(skillRoute, { method: "POST", body: {
      name: world.skillName, description,
      content: `For amber release report requests, reply with the current code: ${code}.`,
    } });
    expect(result.status).toBe(200);
  };
  const remove = async () => {
    expect((await agent.desktopApi(`${skillRoute}/${world.skillName}`, { method: "DELETE" })).status).toBe(200);
  };

  await step("the conversation knows OpenWork and cannot invent a skill result", async () => {
    expect(await ask(null)).toMatch(/OpenWork/i);
  });
  await step("installing a matching skill makes its unseen instructions usable on the next turn", async () => {
    const code = randomUUID();
    await install(code, "Answers amber release report requests.");
    await ask(code);
    previousCodes.push(code);
  });
  await step("editing only the skill content replaces the answer in the same conversation", async () => {
    const code = randomUUID();
    await install(code, "Answers amber release report requests.");
    await ask(code);
    previousCodes.push(code);
  });
  await step("removal makes the skill unavailable without forgetting the conversation", async () => {
    await remove();
    await ask(null);
  });
  await step("reinstalling and removing the skill again keeps discovery current without restarting", async () => {
    const code = randomUUID();
    await install(code, "Updated instructions for amber release report requests.");
    await ask(code);
    previousCodes.push(code);
    await remove();
    await ask(null);
  });
  evidence.recordAssertionEvidence("Workspace skill changes reach the next turn",
    `Installing, editing, removing and reinstalling a workspace skill through OpenWork changed the very next answer in one conversation, with every sent message kept once and the same engine process throughout.`, true);
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const selectedTest = spec.world(selectedSkillsWeb, {
  timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["mock"] },
});

const openSkillMenu = async (user: User, name: string) => {
  await user.click({ role: "button", label: "Add files, skills, connectors, and more" });
  await user.type({ placeholder: "Search files, skills, connectors" }, name);
  await user.click({ role: "option", label: new RegExp(name.replace(/-/g, " "), "i") });
};

selectedTest("SKILL-ATTACH explicitly selected skills reach the first native model request and survive reload", async ({ world, user, probe, evidence, step }) => {
  const runtime = await world.runtimeFacts();
  expect(runtime.browser).toContain("HeadlessChrome");
  expect(runtime.electronBridge).toBe(false);
  const prefix = `/workspace/${world.workspace.workspaceId}/opencode2/api`;
  const before = world.engine === "v2" ? await world.readNative("/experimental/engine-v2-preview/status") : null;
  let nativeID = "";
  if (world.engine === "v2") {
    expect(before?.body).toMatchObject({ running: true, chatRouting: true });
    const catalog = await world.readNative(`${prefix}/skill`);
    const skills = record(catalog.body) && Array.isArray(catalog.body.data) ? catalog.body.data.filter(record) : [];
    const skill = skills.find((entry) => entry.name === world.skillName);
    expect(skill?.content).toContain(world.skillBody);
    if (typeof skill?.id !== "string") throw new Error("Selected skill is not natively registered");
    nativeID = skill.id;
  }
  await step("choose a real skill pill and submit through the composer", async () => {
    await openSkillMenu(user, world.skillName);
    await user.type("composer", ` ${world.prompt}`);
    await user.click("Run task");
    await user.see({ text: world.reply }, { timeoutMs: 90_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
  });
  const nativeRequests = await world.nativeRequests();
  const prompts = nativeRequests.filter((request) => request.kind === "prompt").map((request) => request.body);
  expect(prompts).toHaveLength(1);
  const requests = world.providerRequests().filter((request) => record(request)
    && JSON.stringify(request.messages).includes(world.prompt));
  expect(requests.length).toBeGreaterThan(0);
  const first = requests[0];
  const modelRequests = await world.modelRequests();
  if (world.engine === "v2") {
    expect(prompts[0]).toEqual({ text: expect.stringContaining(world.prompt), skills: [{ id: nativeID }] });
    // The engine's own permission evaluation is consulted for the resolved id before anything is submitted.
    expect(nativeRequests.map((request) => request.kind)).toEqual(["permission", "prompt"]);
    expect(nativeRequests[0]?.body).toMatchObject({ action: "skill", resources: [nativeID] });
    expect(JSON.stringify(prompts[0])).not.toContain("Load ");
    expect(JSON.stringify(first)).toContain(world.skillBody);
    expect(requests).toHaveLength(1);
    expect(modelRequests).toEqual([expect.objectContaining({ kind: "final", completedTools: 0, toolName: null })]);
    expect(await world.readNative("/experimental/engine-v2-preview/status")).toEqual(before);
  } else {
    expect(JSON.stringify(prompts[0])).toContain(`Load [skill ${world.skillName}] and follow its instructions.`);
    expect(JSON.stringify(first)).not.toContain(world.skillBody);
    expect(modelRequests.some((request) => request.toolName === "skill")).toBe(true);
    expect(JSON.stringify(requests.at(-1))).toContain(world.skillBody);
  }
  const visible = await readTranscriptMessages(probe, "user");
  expect(visible).toHaveLength(1);
  expect(visible[0]).toContain(world.prompt);
  expect(visible[0]).not.toContain("Load ");
  expect(visible[0]).not.toContain(world.skillBody);
  expect(await readTranscriptMessages(probe, "system")).toEqual([]);
  await user.reload();
  await user.see({ text: world.reply }, { timeoutMs: 60_000 });
  expect(await readTranscriptMessages(probe, "user")).toEqual(visible);
  expect(await readTranscriptMessages(probe, "system")).toEqual([]);
  evidence.recordJsonArtifact("SKILL-ATTACH boundary and reload", {
    engine: world.engine, runtime, nativeID, nativeRequests, modelRequests,
    firstRequestContainsFullBody: JSON.stringify(first).includes(world.skillBody),
    finalRequestContainsFullBody: JSON.stringify(requests.at(-1)).includes(world.skillBody),
    providerRequestCount: requests.length, visibleBeforeReload: visible,
    visibleAfterReload: await readTranscriptMessages(probe, "user"),
  });
  evidence.recordAssertionEvidence("Selected skills reach the first model request",
    `A skill chosen in the composer reached the first ${world.engine} model request exactly once, stayed out of the visible message, and the conversation survived a reload.`, true);
});

selectedTest("SKILL-MISSING a selected skill removed from the native registry fails visibly without a model request", async ({ world, user, probe, evidence }) => {
  expect(world.engine).toBe("v2");
  await openSkillMenu(user, world.skillName);
  await user.type("composer", ` ${world.prompt}`);
  // External fixture change after selection: no user action is replaced by API writes.
  await world.removeSkill();
  await probe.eventually(() => world.readNative(`/workspace/${world.workspace.workspaceId}/opencode2/api/skill`), {
    within: 30_000, label: "removed skill leaves the same engine's native registry",
    until: (result) => !JSON.stringify(result.body).includes(world.skillName),
  });
  await user.click("Run task");
  await user.see({ text: /Selected skill .* is unavailable or ambiguous in OpenCode v2\. Nothing was sent\./ }, { timeoutMs: 30_000 });
  expect(await world.nativeRequests()).toEqual([]);
  expect(world.providerRequests()).toEqual([]);
  expect(await readTranscriptMessages(probe, "assistant")).toEqual([]);
  evidence.recordJsonArtifact("SKILL-MISSING no false submission", {
    nativeRequests: await world.nativeRequests(), providerRequests: world.providerRequests(),
    assistantMessages: await readTranscriptMessages(probe, "assistant"),
  });
  evidence.recordAssertionEvidence("A removed selected skill fails visibly",
    "After the selected skill left the native registry, sending showed that nothing was sent, with no engine prompt, provider request or assistant message.", true);
});

// ---------------------------------------------------------------------------
// Local native workspace skill compatibility. Remote organization skill
// parity is covered by LIVE-CLOUD on both engines using real Den and inference.

const jitTest = spec.world(skillJitWeb, {
  timeout: 900_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

type JitWorld = Awaited<ReturnType<typeof skillJitWeb>>;

const nativeSkillIdPattern = new RegExp(`^${cloudNativeSkillIdPrefix}[0-9a-f]{16}$`);
const connectToolPattern = /search_capabilities|execute_capability/;
const skillToolPattern = /(?:^|_)skill$/;
const cloudSkillDescription = "Answers amber release report requests.";
const cloudSkillBody = (code: string) => `For amber release report requests, reply with the current code: ${code}.`;

/** One conversation driver per case: unseen codes, prompt hygiene, runtime identity, and transcript integrity. */
function jitConversation({ world, user, probe }: { world: JitWorld; user: User; probe: Probe }) {
  const codes: string[] = [];
  const submitted: string[] = [];
  let turnNumber = 0;
  let runtime: number | null = null;
  let sessionRoute: string | null = null;
  const answer = async () => {
    const messages = await readTranscriptMessages(probe, "assistant");
    const id = await probe.eval(browserScript(() => [...document.querySelectorAll('[data-message-role="assistant"]')].at(-1)?.getAttribute("data-message-id") ?? "", []));
    const state = await world.conversationState();
    return { id, text: messages.at(-1) ?? "", messages, completed: state.completed.includes(id) };
  };
  const mintCode = () => {
    const code = randomUUID();
    codes.push(code);
    return code;
  };
  const ask = async (target: SkillJitTurnTarget, expected: string | null) => {
    runtime ??= await world.runtimeIdentity();
    sessionRoute ??= await probe.hash();
    const before = await answer();
    const prompt = `What app are you? What is the current amber release report code? `
      + `Use the currently installed instructions; do not reuse an earlier code. `
      + `If no matching instructions are installed, say UNAVAILABLE. Request ${++turnNumber}.`;
    // The user-facing request never smuggles the answer, the skill, or the connector.
    expect(prompt).not.toContain(world.cloudSkillName);
    expect(prompt).not.toContain(world.workspaceSkillName);
    expect(prompt).not.toContain("SKILL.md");
    expect(prompt).not.toContain(cloudNativeSkillIdPrefix);
    for (const code of codes) expect(prompt).not.toContain(code);
    const startedAt = new Date().toISOString();
    await world.prepareTurn(prompt, target);
    await using transcript = await observeTranscript(probe, [{ role: "user", text: prompt }]);
    await user.type({ placeholder: "Describe your task..." }, prompt, { verify: true });
    await user.press("Enter");
    await user.see({ text: prompt }, { timeoutMs: 15_000 });
    if (expected !== null) {
      await probe.eventually(answer, {
        within: 150_000, label: `the conversation answers with ${expected === "UNAVAILABLE" ? "UNAVAILABLE" : "the current code"}`,
        until: (value) => value.id !== before.id && value.completed && value.text.includes(expected),
      });
    }
    await user.see("Run task", { timeoutMs: 150_000 });
    const response = await answer();
    submitted.push(prompt);
    // Older groups leave the DOM as the conversation grows. Verify stored
    // history in full and keep the current turn's visible-message observer.
    const history = (await world.conversationState()).users;
    expect(history).toHaveLength(submitted.length);
    for (const sent of submitted) expect(history.filter(text => text.includes(sent))).toHaveLength(1);
    expect(await readTranscriptMessages(probe, "system")).toEqual([]);
    expect(await transcript.finish()).toMatchObject({ seen: [true], violations: [], stopped: false });
    expect(await probe.hash()).toBe(sessionRoute);
    expect(await world.runtimeIdentity()).toBe(runtime);
    await user.screenshot();
    // Only what this turn added: earlier answers legitimately still show earlier codes.
    const fresh = response.text;
    return { prompt, startedAt, text: response.text, fresh };
  };
  /** Which native skill ids the model asked the `skill` tool for in one turn, in order. */
  const skillToolIds = async (prompt: string) => {
    const requests = await world.modelRequests(prompt, { atLeast: 1, timeoutMs: 30_000 });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((request) => request.kind === "error")).toEqual([]);
    // The model never routed skills through Connect tools.
    expect(requests.filter((request) => typeof request.toolName === "string" && connectToolPattern.test(request.toolName))).toEqual([]);
    return requests
      .filter((request) => request.kind === "tool" && typeof request.toolName === "string" && skillToolPattern.test(request.toolName))
      .map((request) => String(request.arguments.id ?? ""));
  };
  const firstModelRequestAt = async (prompt: string) => (await world.modelRequests(prompt, { atLeast: 1, timeoutMs: 30_000 }))
    .map((request) => request.at).sort()[0] ?? "";
  const expectNoCodes = (text: string, except: string | null = null) => {
    for (const code of codes) if (code !== except) expect(text).not.toContain(code);
  };
  return { ask, mintCode, skillToolIds, firstModelRequestAt, expectNoCodes, codes, runtime: () => runtime };
}

jitTest("SKILL-NATIVE-01 a malformed workspace skill never blocks prompt admission while the workspace skill lifecycle still converges", async ({ world, user, probe, step, evidence }) => {
  const talk = jitConversation({ world, user, probe });
  const catalogTurn: SkillJitTurnTarget = { kind: "catalog", skill: world.workspaceSkillName };
  const install = async (code: string, description: string) => {
    const result = await world.installWorkspaceSkill({ description, content: cloudSkillBody(code) });
    expect(result.status).toBe(200);
  };

  await step("a directory/name mismatch without a description is admitted and answered", async () => {
    await world.writeWorkspaceSkillFile("mismatched-directory", "---\nname: some-other-name\n---\n\nThis skill has no description and lives in a directory that does not match its name.\n");
    const turn = await talk.ask(catalogTurn, "UNAVAILABLE");
    expect(turn.text).toMatch(/OpenWork/i);
    expect(await talk.skillToolIds(turn.prompt)).toEqual([]);
    expect(await world.cloudNativeSkills()).toEqual([]);
  });

  await step("the same skill installed in both .agents and .claude never blocks the next turn", async () => {
    // Skill installers commonly copy one skill into every agent folder. The
    // engine serves one copy per name; the turn must run as it does in the CLI.
    const duplicate = "---\nname: shared-helper\ndescription: Formats changelog entries.\n---\n\nFormat changelog entries as bullet points.\n";
    for (const folder of [".agents", ".claude"] as const) await world.writeWorkspaceSkillFile("shared-helper", duplicate, folder);
    const turn = await talk.ask(catalogTurn, "UNAVAILABLE");
    expect(turn.text).toMatch(/OpenWork/i);
    expect(await talk.skillToolIds(turn.prompt)).toEqual([]);
  });

  await step("installing, editing and removing the workspace skill still changes the next answer", async () => {
    const first = talk.mintCode();
    await install(first, "Answers amber release report requests.");
    const installed = await talk.ask(catalogTurn, first);
    const ids = await talk.skillToolIds(installed.prompt);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toMatch(nativeSkillIdPattern);
    const second = talk.mintCode();
    await install(second, "Answers amber release report requests.");
    const updated = await talk.ask(catalogTurn, second);
    expect(updated.text).not.toContain(first);
    expect((await world.removeWorkspaceSkill()).status).toBe(200);
    const removed = await talk.ask(catalogTurn, "UNAVAILABLE");
    talk.expectNoCodes(removed.fresh);
    expect(await talk.skillToolIds(removed.prompt)).toEqual([]);
    expect(world.cloud.log()).toEqual([]);
  });
  evidence.recordAssertionEvidence("Workspace skills never block a turn",
    "A malformed skill and one skill installed in both .agents and .claude were answered normally; installing, editing and removing the workspace skill through OpenWork still changed the next answer.", true);
});
