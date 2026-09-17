import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { gatewayRouterChat } from "../worlds/gateway-router-chat.ts";

const test = spec.world(gatewayRouterChat, {
  timeout: 900_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

test("actual app composer routes original programming and writing turns through a persisted router", async ({ world, user, agent, probe, step, evidence }) => {
  expect(world.persisted).toMatchObject(world.definition);
  const facts = await world.runtimeFacts();
  evidence.recordJsonArtifact("Source app and real managed engine receipt", facts);
  expect(facts.actualSourceSha).toMatch(/^[a-f0-9]{40}$/);
  expect(facts.hostKind).toBe("local");
  expect(facts.binary.version).toBe(facts.expectedEngineVersion);
  expect(facts.nativeHealth).toMatchObject({ healthy: true, version: facts.binary.version });
  for (const [index, item] of world.cases.entries()) {
    const session = world.sessions[index];
    if (!session) throw new Error("Missing isolated chat session");
    expect(item.prompt).not.toMatch(/gwr_|gwm_|ipr_/);
    expect(await agent.run("session.open", { sessionId: session.sessionId })).toMatchObject({ ok: true });
    await user.see("composer", { editable: true });
    await user.type("composer", item.prompt, { replace: true });
    await probe.eventually(() => probe.composer(), { within: 30_000, label: "composer ready", until: value => value.runTaskEnabled });
    await user.press("Enter");
    await probe.eventually(() => world.visible(session.sessionId), {
      within: 90_000, label: "controlled routed answer visible in actual chat", until: messages => messages.some(message => message.includes(item.answer)),
    });
    const native = await world.native(session.sessionId);
    expect(native.filter(message => message.role === "user")).toEqual([{ role: "user", error: undefined, text: item.prompt }]);
    expect(native.filter(message => message.role === "assistant")).toEqual([{ role: "assistant", error: undefined, text: item.answer }]);
    const witness = await world.witness(item.prompt);
    expect(witness.evaluations).toHaveLength(1);
    expect(witness.dispatches).toHaveLength(1);
    expect(witness.dispatches[0]).toMatchObject({ status: 200, route: item.route, fallback: item.fallback, body: { model: "auto" } });
    expect(witness.upstream).toHaveLength(1);
    expect(witness.upstream[0]).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer fixture-upstream-key", body: { model: item.model, stream: true } });
    for (const other of world.cases.filter(other => other !== item)) expect(JSON.stringify(witness.upstream)).not.toContain(other.prompt);
    evidence.recordJsonArtifact(`Original turn ${index + 1}: native and Gateway/provider witnesses`, {
      prompt: item.prompt, native,
      evaluations: witness.evaluations.map(entry => ({ text: entry.text })),
      dispatches: witness.dispatches.map(entry => ({ status: entry.status, route: entry.route, fallback: entry.fallback })),
      upstream: witness.upstream.map(entry => ({ path: entry.path, model: entry.body.model, stream: entry.body.stream,
        expectedCredentialMatched: entry.authorization === "Bearer fixture-upstream-key" })),
    });
    await step(`actual chat ${item.route} ${item.fallback}`, () => user.screenshot());
  }
  evidence.recordAssertionEvidence("Joined app → real OpenCode → real Gateway → controlled provider", "Three composer sends have exact original native turns, visible answers, one matching dispatch each, two upstream models and low-confidence fallback. Classification is injected, not live Jev; no visual-model verdict claimed.", true);
});
