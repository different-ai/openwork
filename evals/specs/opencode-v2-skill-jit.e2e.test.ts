import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { liveOpenAiEnabled } from "@openwork/behaviors";
import { observeTranscript, readTranscriptMessages, spec } from "@openwork/testkit";
import { skillLifecycle } from "../worlds/chat.ts";

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
    await world.prepareTurn(prompt, expected !== null);
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
