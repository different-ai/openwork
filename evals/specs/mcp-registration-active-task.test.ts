import { expect } from "vitest";
import { eventually, spec } from "@openwork/testkit";
import { mcpRegistration } from "../worlds/mcp-registration.ts";

// New boundary journey: an active task must retain its MCP client while
// OpenWork delivers runtime configuration to the real managed engine.
const test = spec.world(mcpRegistration, { needs: { commands: ["bun"] }, timeout: 180_000 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("runtime MCP synchronization preserves captured and in-flight tools, then applies changes and recovers", async ({ world, evidence }) => {
  const stages: Array<"model" | "tool"> = ["model", "tool"];
  for (const stage of stages) {
    world.pause(stage);
    const session = await world.engine("POST", "/session", {});
    if (!isRecord(session) || typeof session.id !== "string") throw new Error("Session id missing");
    const id = session.id;
    await world.engine("POST", `/session/${id}/prompt_async`, {
      model: { providerID: "mock", modelID: "mock" },
      parts: [{ type: "text", text: "Check the connection." }],
    });
    await world.entered();
    const before = world.initializations();
    // The first call has only a disk-bootstrapped client (no registration
    // receipt). The second has a known client whose fingerprint is unchanged.
    await world.register();
    expect(world.initializations()).toBe(before);
    if (stage === "tool") {
      await world.register("changed");
      expect(world.initializations()).toBe(before);
    }
    world.release();
    const states = await eventually(async () => {
      const messages = await world.engine("GET", `/session/${id}/message`);
      if (!Array.isArray(messages)) return [];
      return messages.filter(isRecord).flatMap((message) => Array.isArray(message.parts) ? message.parts.filter(isRecord) : [])
        .filter((part) => part.type === "tool" && isRecord(part.state)).map((part) => part.state);
    }, { within: 30_000, label: `${stage} paused tool completes`, until: (states) => states.length === 1 && isRecord(states[0]) && ["completed", "error"].includes(String(states[0].status)) });
    expect(states).toMatchObject([{ status: "completed", output: "pong" }]);
    await eventually(() => world.engine("GET", "/session/status"), {
      within: 10_000, label: "task finishes before idle registration",
      until: (statuses) => isRecord(statuses) && (!isRecord(statuses[id]) || statuses[id].type === "idle"),
    });
    expect(world.requests().filter((request) => request.method === "tools/call").at(-1)?.revision).toBe(stage === "model" ? null : "original");
    const calls = await world.toolCalls();
    expect(calls.filter((call) => call.name === "ping")).toHaveLength(stage === "model" ? 1 : 2);
    evidence.recordAssertionEvidence(
      `Registration preserves the ${stage === "model" ? "client captured before a call" : "in-flight tool call"}`,
      `No new MCP initialization during registration; the real engine persisted one completed pong tool and the connector witnessed exactly ${stage === "model" ? 1 : 2} total invocations.`,
      true,
    );
    await world.register(stage === "tool" ? "changed" : "original");
    expect(world.initializations()).toBe(before + 1);
    expect(world.requests().filter((request) => request.method === "initialize").at(-1)?.revision).toBe(stage === "tool" ? "changed" : "original");
    const after = world.initializations();
    await world.register(stage === "tool" ? "changed" : "original");
    expect(world.initializations()).toBe(after);
  }
  const changedSession = await world.engine("POST", "/session", {});
  if (!isRecord(changedSession) || typeof changedSession.id !== "string") throw new Error("Session id missing");
  const changedId = changedSession.id;
  await world.engine("POST", `/session/${changedId}/prompt_async`, {
    model: { providerID: "mock", modelID: "mock" },
    parts: [{ type: "text", text: "Check the connection." }],
  });
  await eventually(() => world.toolCalls(), {
    within: 15_000, label: "changed connection invokes the connector",
    until: (calls) => calls.filter((call) => call.name === "ping").length === 3,
  });
  expect(world.requests().filter((request) => request.method === "tools/call").at(-1)?.revision).toBe("changed");
  await eventually(() => world.engine("GET", "/session/status"), {
    within: 10_000, label: "changed connection task finishes before recovery",
    until: (statuses) => isRecord(statuses) && (!isRecord(statuses[changedId]) || statuses[changedId].type === "idle"),
  });
  evidence.recordAssertionEvidence(
    "The replacement receives and uses the changed configuration",
    "The MCP endpoint observed x-fixture-revision=changed on initialization and a subsequent real engine tools/call; earlier active calls retained their previous revision.",
    true,
  );
  const beforeRecovery = world.initializations();
  await world.engine("POST", "/mcp/race/disconnect", {});
  await world.register("changed");
  expect(world.initializations()).toBe(beforeRecovery + 1);
  expect(world.requests().filter((request) => request.method === "initialize").at(-1)?.revision).toBe("changed");
  expect(await world.engine("GET", "/mcp")).toMatchObject({ race: { status: "connected" } });
  evidence.recordAssertionEvidence(
    "Idle changes apply once, unchanged registrations are no-ops, and disconnected clients recover",
    "Each deferred change caused exactly one initialization after idle; an identical repeat caused none. After an explicit disconnect, registration initialized once and the real engine reported connected.",
    true,
  );
  const session = await world.engine("POST", "/session", {});
  if (!isRecord(session) || typeof session.id !== "string") throw new Error("Session id missing");
  const id = session.id;
  world.pause("initialize");
  const replacement = world.register("admission-check");
  await world.entered();
  let admitted = false;
  const prompt = world.engine("POST", `/session/${id}/prompt_async`, {
    model: { providerID: "mock", modelID: "mock" },
    parts: [{ type: "text", text: "Check the connection." }],
  }).then(() => { admitted = true; });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const admittedDuringReplacement = admitted;
  world.release();
  await Promise.all([replacement, prompt]);
  expect(admittedDuringReplacement).toBe(false);
  expect(admitted).toBe(true);
  await eventually(() => world.toolCalls(), {
    within: 15_000, label: "admitted task invokes the replacement connection",
    until: (calls) => calls.filter((call) => call.name === "ping").length === 4,
  });
  expect(world.requests().filter((request) => request.method === "initialize").at(-1)?.revision).toBe("admission-check");
  expect(world.requests().filter((request) => request.method === "tools/call").at(-1)?.revision).toBe("admission-check");
  evidence.recordAssertionEvidence(
    "Managed-engine prompt admission waits for an ongoing connection replacement",
    "The async prompt remained unacknowledged while initialization was paused, was acknowledged after replacement finished, and invoked the connector exactly once.",
    true,
  );
});
