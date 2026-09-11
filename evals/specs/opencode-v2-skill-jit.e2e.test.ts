import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { liveOpenAiEnabled } from "@openwork/behaviors";
import { observeTranscript, readTranscriptMessages, spec, type User } from "@openwork/testkit";
import { skillLifecycle } from "../worlds/chat.ts";
import { selectedSkillsWeb } from "../worlds/selected-skills.ts";

const test = spec.world(skillLifecycle, {
  timeout: 900_000,
  needs: liveOpenAiEnabled() ? { env: ["OPENAI_API_KEY"], daytona: true } : {},
});

// The engine is selected by the world. The journey does not inspect injected
// instructions, catalog formatting, native tool names, or engine message shapes.
test("workspace skills change during an ongoing conversation", async ({ world, user, agent, probe, step }) => {
  const runtime = await world.runtimeIdentity();
  const sessionRoute = await probe.hash();
  const skillRoute = `/workspace/${world.workspace.workspaceId}/skills`;
  const previousCodes: string[] = [];
  let turnNumber = 0;
  const submitted: string[] = [];
  const answer = async () => {
    const messages = await readTranscriptMessages(probe, "assistant");
    return { count: messages.length, text: messages.at(-1) ?? "" };
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
    await user.type({ placeholder: "Describe your task..." }, prompt, { verify: true });
    await user.press("Enter");
    await user.see({ text: prompt }, { timeoutMs: 15_000 });
    const response = await probe.eventually(answer, {
      within: 150_000, label: "the conversation answers using the currently installed instructions",
      until: (value) => record(value) && record(before) && Number(value.count) > Number(before.count)
        && typeof value.text === "string" && value.text.includes(expected ?? "UNAVAILABLE"),
    });
    await user.see("Run task", { timeoutMs: 60_000 });
    submitted.push(prompt);
    const visibleUserMessages = await readTranscriptMessages(probe, "user");
    expect(visibleUserMessages).toHaveLength(submitted.length);
    visibleUserMessages.forEach((text, index) => expect(text).toContain(submitted[index]));
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
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const selectedTest = spec.world(selectedSkillsWeb, {
  timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["mock"] },
});

const openSkillMenu = async (user: User, name: string) => {
  await user.click({ role: "button", label: "Agents, commands, skills, plugins, and connections" });
  await user.click({ role: "button", label: "Skills" });
  await user.click({ role: "button", label: new RegExp(name) });
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
});
