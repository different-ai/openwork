import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  MARKERS,
  REPLY,
  openAICompatibleSystemOrder,
} from "../worlds/openai-compatible-system-order.ts";

const test = spec.world(openAICompatibleSystemOrder, {
  needs: { commands: ["bun"] },
  timeout: 240_000,
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionId(value: unknown): string {
  if (!record(value) || typeof value.id !== "string") throw new Error("Missing session id");
  return value.id;
}

test("OpenAI-compatible requests keep every system contribution first and in one message", { timeout: 240_000 }, async ({ world, evidence }) => {
  const id = sessionId(await world.engine("POST", "/session", { title: "System ordering witness" }));
  const result = await world.engine("POST", `/session/${id}/message`, {
    model: { providerID: "strict", modelID: "strict-system-order" },
    system: MARKERS.perTurn,
    parts: [{ type: "text", text: MARKERS.user }],
  });

  expect(world.requests).toHaveLength(1);
  const request = world.requests[0];
  expect(request.systemIndexes).toEqual([0]);
  expect(request.rejected).toBe(false);
  expect(request.roles[0]).toBe("system");
  expect(request.roles).toContain("user");
  expect(record(result) && record(result.info) && result.info.error).toBeUndefined();
  expect(record(result) && Array.isArray(result.parts) && result.parts.filter(record).some((part) => part.text === REPLY)).toBe(true);

  const ordered = [
    "You are OpenWork.",
    MARKERS.agent,
    MARKERS.skill,
    MARKERS.perTurn,
    MARKERS.pluginOne,
    MARKERS.pluginTwo,
  ];
  let previous = -1;
  for (const marker of ordered) {
    const current = request.systemText.indexOf(marker);
    expect(current).toBeGreaterThan(previous);
    previous = current;
  }
  expect(request.systemText).not.toContain(MARKERS.user);
  expect(request.userText).toContain(MARKERS.user);

  evidence.recordAssertionEvidence(
    "Strict OpenAI-compatible endpoint accepts one ordered system message",
    "The managed OpenCode request passed a witness that rejects every system role after index zero. Agent, project AGENTS.md, skill catalog, per-turn, and two runtime-plugin contributions remained in source order inside the sole system message; the user message remained a user message.",
    true,
  );
});
