import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { liveOpenAiEnabled } from "@openwork/behaviors";
import { observeTranscript, readTranscriptMessages, spec, type Probe, type User } from "@openwork/testkit";
import { skillLifecycle } from "../worlds/chat.ts";
import { selectedSkillsWeb } from "../worlds/selected-skills.ts";
import {
  cloudNativeSkillIdPrefix,
  skillJitAccounts,
  skillJitWeb,
  type NativeSkillEntry,
  type SkillJitTurnTarget,
} from "../worlds/skill-jit.ts";

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

// ---------------------------------------------------------------------------
// Headless app-web world: Cloud skills materialized natively, just in time.
// The Cloud endpoint is an identity-scoped fixture; codes are random, unseen,
// and never appear in prompts or skill metadata. Every claim carries its
// negative half (other account, other code, no Connect tool call, no leak).
// ---------------------------------------------------------------------------

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
    return { count: messages.length, text: messages.at(-1) ?? "", messages };
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
        until: (value) => value.count > before.count && value.text.includes(expected),
      });
    }
    await user.see("Run task", { timeoutMs: 150_000 });
    const response = await answer();
    submitted.push(prompt);
    const visibleUserMessages = await readTranscriptMessages(probe, "user");
    expect(visibleUserMessages).toHaveLength(submitted.length);
    visibleUserMessages.forEach((text, index) => expect(text).toContain(submitted[index]));
    expect(await readTranscriptMessages(probe, "system")).toEqual([]);
    expect(await transcript.finish()).toMatchObject({ seen: [true], violations: [], stopped: false });
    expect(await probe.hash()).toBe(sessionRoute);
    expect(await world.runtimeIdentity()).toBe(runtime);
    await user.screenshot();
    // Only what this turn added: earlier answers legitimately still show earlier codes.
    const fresh = response.messages.slice(before.count).join("\n");
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

function expectCloudNativeEntry(entry: NativeSkillEntry | undefined, world: JitWorld, code: string): NativeSkillEntry {
  if (!entry) throw new Error("The native registry has no Cloud skill entry");
  expect(entry.id).toMatch(nativeSkillIdPattern);
  expect(entry.name).toBe(world.cloudSkillName);
  expect(entry.content.trim()).toContain(cloudSkillBody(code));
  expect(entry.location).not.toBe("");
  expect(world.locationLeaks(entry.location)).toEqual({ workspace: false, home: false });
  return entry;
}

jitTest("SKILL-CLOUD-01 a Cloud skill is native before the first prompt, updates by body, and disappears on revoke", async ({ world, user, probe, step, evidence }) => {
  const talk = jitConversation({ world, user, probe });
  const account = skillJitAccounts.a;
  const catalogTurn: SkillJitTurnTarget = { kind: "catalog", skill: world.cloudSkillName };
  const indexUri = "skill://index.json";
  const skillUri = world.cloud.skillUri(world.cloudSkillName);
  let skillId = "";

  await step("without a Cloud connection the conversation knows OpenWork and no Cloud skill exists", async () => {
    expect(await world.cloudNativeSkills()).toEqual([]);
    const turn = await talk.ask(catalogTurn, "UNAVAILABLE");
    expect(turn.text).toMatch(/OpenWork/i);
    expect(await talk.skillToolIds(turn.prompt)).toEqual([]);
    expect(world.cloud.log()).toEqual([]);
    evidence.recordAssertionEvidence(
      "No Cloud config means no Cloud skill and no contact with the Cloud endpoint",
      `registry cloud entries=0; fixture requests=${world.cloud.log().length}; answer=${JSON.stringify(turn.text.slice(0, 80))}`,
      true,
    );
  });

  await step("authorizing account A makes the unseen skill body answer the very first prompt through the native skill tool", async () => {
    const code = talk.mintCode();
    world.cloud.publishSkill(account, { name: world.cloudSkillName, description: cloudSkillDescription, body: cloudSkillBody(code) });
    const receipt = await world.authorizeCloud(account);
    expect(receipt.status).toBe(200);
    expect(receipt.desiredPresent).toBe(true);
    const turn = await talk.ask(catalogTurn, code);
    talk.expectNoCodes(turn.text, code);
    const registry = await world.cloudNativeSkills();
    expect(registry).toHaveLength(1);
    const entry = expectCloudNativeEntry(registry[0], world, code);
    skillId = entry.id;
    expect(await talk.skillToolIds(turn.prompt)).toEqual([skillId]);
    const reads = world.cloud.resourceReads({ sinceIso: turn.startedAt });
    expect(reads.every((read) => read.identity === account && read.authorized)).toBe(true);
    const indexRead = reads.find((read) => read.uri === indexUri);
    const bodyRead = reads.find((read) => read.uri === skillUri);
    if (!indexRead || !bodyRead) throw new Error(`Expected index and body reads, saw ${JSON.stringify(reads.map((read) => read.uri))}`);
    const modelAt = await talk.firstModelRequestAt(turn.prompt);
    expect(indexRead.at <= modelAt).toBe(true);
    expect(bodyRead.at <= modelAt).toBe(true);
    expect(world.cloud.toolCallNames()).toEqual([]);
    evidence.recordAssertionEvidence(
      "The host read skill://index.json and the SKILL.md body before the first model request, registered the skill natively, and made zero Connect tool calls",
      `id=${skillId}; indexRead=${indexRead.at}; bodyRead=${bodyRead.at}; firstModelRequest=${modelAt}; toolsCall=${world.cloud.toolCallNames().length}; location outside workspace/home=${JSON.stringify(world.locationLeaks(entry.location))}`,
      true,
    );
  });

  await step("a body-only update returns the new code on the next turn with the same skill id and runtime", async () => {
    const previous = talk.codes[0] ?? "";
    const code = talk.mintCode();
    const runtimeBefore = await world.runtimeIdentity();
    world.cloud.updateSkillBody(account, world.cloudSkillName, cloudSkillBody(code));
    const turn = await talk.ask(catalogTurn, code);
    expect(turn.text).not.toContain(previous);
    const registry = await world.cloudNativeSkills();
    expect(registry).toHaveLength(1);
    const entry = expectCloudNativeEntry(registry[0], world, code);
    expect(entry.id).toBe(skillId);
    expect(entry.content).not.toContain(previous);
    expect(await talk.skillToolIds(turn.prompt)).toEqual([skillId]);
    expect(await world.runtimeIdentity()).toBe(runtimeBefore);
    expect(world.cloud.toolCallNames()).toEqual([]);
    evidence.recordAssertionEvidence(
      "A body-only update keeps the native id stable and replaces the served instructions without restarting the engine",
      `id=${entry.id}; pid=${runtimeBefore}; newCodeVisible=${turn.text.includes(code)}; oldCodeVisible=${turn.text.includes(previous)}`,
      entry.id === skillId && turn.text.includes(code) && !turn.text.includes(previous),
    );
  });

  await step("revoking the skill removes it before the next prompt, and a forced load of the stale id fails honestly", async () => {
    expect(world.cloud.revokeSkill(account, world.cloudSkillName)).toBe(true);
    const turn = await talk.ask(catalogTurn, "UNAVAILABLE");
    talk.expectNoCodes(turn.fresh);
    expect(await world.cloudNativeSkills()).toEqual([]);
    expect(await talk.skillToolIds(turn.prompt)).toEqual([]);
    const reads = world.cloud.resourceReads({ sinceIso: turn.startedAt });
    expect(reads.some((read) => read.uri === indexUri && read.identity === account)).toBe(true);
    expect(reads.filter((read) => read.uri === skillUri)).toEqual([]);
    const firstRead = reads.map((read) => read.at).sort()[0] ?? "";
    expect(firstRead <= await talk.firstModelRequestAt(turn.prompt)).toBe(true);

    const forced = await talk.ask({ kind: "forced", skillId }, null);
    talk.expectNoCodes(forced.fresh);
    expect(forced.fresh).not.toContain(cloudSkillBody("").slice(0, 40));
    expect(await world.cloudNativeSkills()).toEqual([]);
    const forcedIds = await talk.skillToolIds(forced.prompt);
    expect(forcedIds).toEqual([skillId]);
    expect(world.cloud.toolCallNames()).toEqual([]);
    evidence.recordAssertionEvidence(
      "After revocation the registry is empty before the next prompt and forcing the stale native id yields no instructions",
      `staleId=${skillId}; forcedToolRounds=${forcedIds.length}; codesVisible=false; cloudToolCalls=${world.cloud.toolCallNames().length}`,
      true,
    );
  });
});

jitTest("SKILL-CLOUD-02 two accounts on one endpoint never see each other's skill body, and removing Cloud leaves nothing behind", async ({ world, user, probe, step, evidence }) => {
  const talk = jitConversation({ world, user, probe });
  const catalogTurn: SkillJitTurnTarget = { kind: "catalog", skill: world.cloudSkillName };
  const codeA = talk.mintCode();
  const codeB = talk.mintCode();
  const locations: string[] = [];
  world.cloud.publishSkill(skillJitAccounts.a, { name: world.cloudSkillName, description: cloudSkillDescription, body: cloudSkillBody(codeA) });
  world.cloud.publishSkill(skillJitAccounts.b, { name: world.cloudSkillName, description: cloudSkillDescription, body: cloudSkillBody(codeB) });

  await step("account A receives only A's body", async () => {
    expect((await world.authorizeCloud(skillJitAccounts.a)).status).toBe(200);
    const turn = await talk.ask(catalogTurn, codeA);
    expect(turn.text).not.toContain(codeB);
    const entry = expectCloudNativeEntry((await world.cloudNativeSkills())[0], world, codeA);
    expect(entry.content).not.toContain(codeB);
    locations.push(entry.location);
    const reads = world.cloud.resourceReads({ sinceIso: turn.startedAt });
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((read) => read.identity !== skillJitAccounts.a)).toEqual([]);
    expect(await talk.skillToolIds(turn.prompt)).toEqual([entry.id]);
  });

  await step("switching the connection to account B replaces the body; B never sees A's code", async () => {
    expect((await world.authorizeCloud(skillJitAccounts.b)).status).toBe(200);
    const turn = await talk.ask(catalogTurn, codeB);
    expect(turn.text).not.toContain(codeA);
    const registry = await world.cloudNativeSkills();
    expect(registry).toHaveLength(1);
    const entry = expectCloudNativeEntry(registry[0], world, codeB);
    expect(entry.content).not.toContain(codeA);
    locations.push(entry.location);
    const reads = world.cloud.resourceReads({ sinceIso: turn.startedAt });
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((read) => read.identity === skillJitAccounts.a)).toEqual([]);
    expect(reads.every((read) => read.identity === skillJitAccounts.b && read.authorized)).toBe(true);
    expect(await talk.skillToolIds(turn.prompt)).toEqual([entry.id]);
    expect(world.cloud.toolCallNames()).toEqual([]);
    evidence.recordAssertionEvidence(
      "Account B's turn read only B's resources and answered only B's code",
      `reads=${reads.length}; identities=${JSON.stringify([...new Set(reads.map((read) => read.identity))])}; aCodeVisible=${turn.text.includes(codeA)}; bCodeVisible=${turn.text.includes(codeB)}`,
      !turn.text.includes(codeA) && turn.text.includes(codeB),
    );
  });

  await step("removing the Cloud config while B's skill is materialized deletes the private files, empties the registry, stops all endpoint contact, and leaves nothing in the workspace or home", async () => {
    // Switching to B already deleted A's private file; B's is live until the config goes away.
    const [locationA, locationB] = locations;
    if (!locationA || !locationB) throw new Error("Both account materializations must have been recorded");
    expect(await world.materializedFileExists(locationA)).toBe(false);
    expect(await world.materializedFileExists(locationB)).toBe(true);
    const removal = await world.removeCloud();
    expect(removal.status).toBe(200);
    expect(removal.remaining).not.toContain("openwork-cloud");
    const contactsBefore = world.cloud.log().length;
    const turn = await talk.ask(catalogTurn, "UNAVAILABLE");
    talk.expectNoCodes(turn.fresh);
    expect(await world.cloudNativeSkills()).toEqual([]);
    expect(await talk.skillToolIds(turn.prompt)).toEqual([]);
    expect(world.cloud.log().length).toBe(contactsBefore);
    // The engine-private bodies are gone from disk, not merely unregistered.
    for (const location of locations) expect(await world.materializedFileExists(location)).toBe(false);
    expect(await world.workspaceFilesContaining([codeA, codeB, cloudNativeSkillIdPrefix])).toEqual([]);
    for (const location of locations) expect(world.locationLeaks(location)).toEqual({ workspace: false, home: false });
    expect(world.cloud.toolCallNames()).toEqual([]);
    evidence.recordAssertionEvidence(
      "Removing the Cloud config with an active materialization deletes the private SKILL.md files, empties the registry, and stops endpoint contact; no body reached the workspace or home",
      `fixtureRequestsBefore=${contactsBefore}; after=${world.cloud.log().length}; privateLocations=${locations.length}; filesRemaining=0; workspaceMatches=0`,
      true,
    );
  });

  await step("re-authorizing B then losing authorization (401) fails closed: the skill and its file disappear before the next prompt", async () => {
    expect((await world.authorizeCloud(skillJitAccounts.b)).status).toBe(200);
    const restored = await talk.ask(catalogTurn, codeB);
    expect(restored.text).not.toContain(codeA);
    const entry = expectCloudNativeEntry((await world.cloudNativeSkills())[0], world, codeB);
    expect(await world.materializedFileExists(entry.location)).toBe(true);
    world.cloud.setAuthorization(skillJitAccounts.b, false);
    const turn = await talk.ask(catalogTurn, "UNAVAILABLE");
    talk.expectNoCodes(turn.fresh);
    expect(await world.cloudNativeSkills()).toEqual([]);
    expect(await world.materializedFileExists(entry.location)).toBe(false);
    expect(await talk.skillToolIds(turn.prompt)).toEqual([]);
    const refused = world.cloud.log({ sinceIso: turn.startedAt, identity: skillJitAccounts.b }).filter((log) => log.status === 401);
    expect(refused.length).toBeGreaterThan(0);
    expect(world.cloud.resourceReads({ sinceIso: turn.startedAt }).filter((read) => read.status === 200)).toEqual([]);
    expect(world.cloud.toolCallNames()).toEqual([]);
    evidence.recordAssertionEvidence(
      "A 401 from the Cloud endpoint clears the materialized skill and its file before the prompt is admitted; the conversation still answers",
      `refused401=${refused.length}; registryAfter=0; fileRemaining=false; answeredUnavailable=${turn.text.includes("UNAVAILABLE")}`,
      turn.text.includes("UNAVAILABLE"),
    );
  });
});

jitTest("SKILL-NATIVE-01 a malformed workspace skill never blocks prompt admission while the workspace skill lifecycle still converges", async ({ world, user, probe, step }) => {
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
});
