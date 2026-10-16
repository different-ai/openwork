import { expect } from "vitest";
import { readTranscriptMessages, spec, type User } from "@openwork/testkit";
import { deniedSelectedSkillsWeb } from "../worlds/selected-skills.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const openSkillMenu = async (user: User, name: string) => {
  await user.click({ role: "button", label: "Add files, skills, connectors, and more" });
  await user.type({ placeholder: "Search files, skills, connectors" }, name);
  await user.click({ role: "option", label: new RegExp(name.replace(/-/g, " "), "i") });
};


const deniedTest = spec.world(deniedSelectedSkillsWeb, {
  timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["mock"] },
});

deniedTest("SKILL-DENIED a workspace skill rule denies explicit selection without a prompt or model request", async ({ world, user, probe, evidence, step }) => {
  expect(world.engine).toBe("v2");
  const prefix = `/workspace/${world.workspace.workspaceId}/opencode2/api`;
  const agents = await probe.eventually(() => world.readNative(`${prefix}/agent`), {
    within: 30_000, label: "workspace skill denial reaches every native agent",
    until: (result) => result.status === 200 && record(result.body) && Array.isArray(result.body.data)
      && result.body.data.length > 0 && result.body.data.every((agent) => record(agent) && Array.isArray(agent.permissions)
        && agent.permissions.some((rule) => record(rule) && rule.action === "skill" && rule.resource === "*" && rule.effect === "deny")),
  });
  const catalog = await world.readNative(`${prefix}/skill`);
  expect(catalog.status).toBe(200);
  const skills = record(catalog.body) && Array.isArray(catalog.body.data) ? catalog.body.data.filter(record) : [];
  const skill = skills.find((entry) => entry.name === world.skillName);
  if (typeof skill?.id !== "string") throw new Error("Denied skill is not natively registered");
  expect(skill.content).toContain(world.skillBody);

  await step("a real selected skill is refused by the native permission check before submission", async () => {
    await openSkillMenu(user, world.skillName);
    await user.type("composer", ` ${world.prompt}`);
    await user.click("Run task");
    await user.see({ text: "Selected skills are not permitted in OpenCode v2. Nothing was sent." }, { timeoutMs: 30_000 });
  });
  const nativeRequests = await world.nativeRequests();
  expect(nativeRequests).toEqual([{
    kind: "permission", body: { action: "skill", resources: [skill.id], save: [skill.id] },
    status: 200, response: { data: { id: expect.any(String), effect: "deny" } },
  }]);
  expect(world.providerRequests()).toEqual([]);
  expect(await readTranscriptMessages(probe, "assistant")).toEqual([]);
  const messages = await world.readNative(`${prefix}/session/${world.session.sessionId}/message`);
  expect(messages.status).toBe(200);
  expect(messages.body).toMatchObject({ data: [] });
  const nativeAgents = record(agents.body) && Array.isArray(agents.body.data) ? agents.body.data.filter(record) : [];
  evidence.recordJsonArtifact("SKILL-DENIED native refusal without dispatch", {
    engine: world.engine, skillId: skill.id,
    agents: nativeAgents.map((agent) => ({ id: agent.id, permissions: Array.isArray(agent.permissions)
      ? agent.permissions.filter((rule) => record(rule) && rule.action === "skill") : [] })),
    nativeRequests, providerRequestCount: world.providerRequests().length, storedMessages: messages.body,
  });
});
