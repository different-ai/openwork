import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { agentSessionModel, MODEL_ID, MOCK_REPLY, PROVIDER_ID, TOOL_CALL_MARKER } from "../worlds/agent-session-model.ts";

/**
 * An agent creates a session with `model.variant: "low"` through the in-app
 * `session.create` affordance and reads it back through `session.read`.
 *
 * The first cut of `session.create` accepted `model` and dropped it, so the
 * created session ran at the engine default while the agent believed it had
 * asked for a specific effort. This spec crosses the real boundary: a scripted
 * model inside the managed engine issues the tool call, openwork-server
 * proxies both engine writes, and the provider stand-in records the
 * `reasoning_effort` the created session's turn actually carried.
 */

const test = spec.world(agentSessionModel, { needs: { commands: ["bun"] }, timeout: 240_000 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionIdOf(value: unknown): string {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error(`Expected a created session: ${JSON.stringify(value)}`);
  }
  return value.id;
}

function replyText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.parts)) return "";
  return value.parts
    .filter(isRecord)
    .filter((part) => part.type === "text")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
}

/** Output of the first completed call of `tool` in a session's transcript. */
function completedToolOutput(messages: unknown, tool: string): string | null {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isRecord(part) || part.type !== "tool" || part.tool !== tool || !isRecord(part.state)) continue;
      if (part.state.status === "completed" && typeof part.state.output === "string") return part.state.output;
    }
  }
  return null;
}

function parseOutput(output: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed)) throw new Error(`Expected object tool output: ${output}`);
  return parsed;
}

function scripted(name: string, args: Record<string, unknown>): string {
  return `${TOOL_CALL_MARKER} ${JSON.stringify({ name, arguments: args })}`;
}

const engineModel = { providerID: PROVIDER_ID, modelID: MODEL_ID };
const requested = { providerId: PROVIDER_ID, modelId: MODEL_ID, variant: "low" };
const CREATED_TITLE = "Created at low effort";
const CREATED_PROMPT = "Reply with OK.";

test("session.create binds the requested reasoning effort and session.read exposes it as `model`", async ({ world, probe, step, evidence }) => {
  const orchestrator = sessionIdOf(await world.engine("POST", "/session", { title: "Orchestrator" }));

  const createOutput = await step("an agent creates a session with model.variant low through session.create", async () => {
    const result = await world.engine("POST", `/session/${encodeURIComponent(orchestrator)}/message`, {
      model: engineModel,
      parts: [{ type: "text", text: scripted("openwork_execute", {
        id: "session.create",
        args: { model: requested, sessions: [{ title: CREATED_TITLE, prompt: CREATED_PROMPT }] },
      }) }],
    });
    const output = await probe.eventually(
      async () => completedToolOutput(await world.engine("GET", `/session/${encodeURIComponent(orchestrator)}/message`), "openwork_execute"),
      { within: 60_000, label: "completed session.create tool call", until: (value) => value !== null },
    );
    if (output === null) throw new Error("session.create did not complete");
    const parsed = parseOutput(output);
    const created = isRecord(parsed.result) && Array.isArray(parsed.result.created) ? parsed.result.created : [];
    const first = created[0];

    expect(parsed.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(isRecord(first) ? first.model : null).toEqual(requested);
    expect(replyText(result)).toBe(MOCK_REPLY);
    evidence.recordAssertionEvidence(
      "session.create reports the model and effort it bound",
      `The tool result listed one created session with model=${JSON.stringify(isRecord(first) ? first.model : null)}.`,
      isRecord(first) && JSON.stringify(first.model) === JSON.stringify(requested),
    );
    return { createdId: isRecord(first) && typeof first.sessionId === "string" ? first.sessionId : "" };
  });
  const createdId = createOutput.createdId;
  if (!createdId) throw new Error("session.create returned no session id");

  await step("the engine's session record carries the variant and the created session's turn ran at that effort", async () => {
    const record = await world.engine("GET", `/session/${encodeURIComponent(createdId)}`);
    const recordModel = isRecord(record) ? record.model : null;
    // The created session's own turn: the prompt is a plain reply, so its one
    // provider request is the one whose newest user message is that prompt
    // (the orchestrator's requests quote the prompt too, inside the scripted call).
    const turn = await probe.eventually(
      async () => world.requests.find((request) => request.userText.includes(CREATED_PROMPT) && !request.userText.includes(TOOL_CALL_MARKER)) ?? null,
      { within: 60_000, label: "provider request for the created session's first turn", until: (value) => value !== null },
    );
    const messages = await world.engine("GET", `/session/${encodeURIComponent(createdId)}/message`);
    const firstUser = Array.isArray(messages) ? messages.map((message) => (isRecord(message) ? message.info : null)).find((info) => isRecord(info) && info.role === "user") : null;
    const userModel = isRecord(firstUser) && isRecord(firstUser.model) ? firstUser.model : null;

    // Persisted on the session (what the SQLite store's session.model column shows).
    expect(recordModel).toEqual({ id: MODEL_ID, providerID: PROVIDER_ID, variant: "low" });
    // Pinned on the first user message and sent to the provider as reasoning_effort.
    expect(userModel).toEqual({ providerID: PROVIDER_ID, modelID: MODEL_ID, variant: "low" });
    expect(turn).toMatchObject({ model: MODEL_ID, reasoningEffort: "low" });
    evidence.recordAssertionEvidence(
      "The created session runs at the requested effort, not the engine default",
      `Engine session record model=${JSON.stringify(recordModel)}; first user message model=${JSON.stringify(userModel)}; the provider received reasoning_effort=${JSON.stringify(turn?.reasoningEffort ?? null)} for ${JSON.stringify(CREATED_PROMPT)}.`,
      turn?.reasoningEffort === "low",
    );
  });

  await step("session.read returns the same model without opening the session", async () => {
    await world.engine("POST", `/session/${encodeURIComponent(orchestrator)}/message`, {
      model: engineModel,
      parts: [{ type: "text", text: scripted("openwork_query", { id: "session.read", args: { sessionId: createdId, count: 5 } }) }],
    });
    const output = await probe.eventually(
      async () => completedToolOutput(await world.engine("GET", `/session/${encodeURIComponent(orchestrator)}/message`), "openwork_query"),
      { within: 60_000, label: "completed session.read tool call", until: (value) => value !== null },
    );
    if (output === null) throw new Error("session.read did not complete");
    const parsed = parseOutput(output);
    const read = isRecord(parsed.result) ? parsed.result : null;

    expect(parsed.ok).toBe(true);
    expect(read?.sessionId).toBe(createdId);
    expect(read?.title).toBe(CREATED_TITLE);
    expect(read?.model).toEqual(requested);
    // The orchestrator itself was prompted without a variant: the engine records
    // its literal "default" there, which agents read back as variant null.
    const orchestratorRecord = await world.engine("GET", `/session/${encodeURIComponent(orchestrator)}`);
    expect(isRecord(orchestratorRecord) ? orchestratorRecord.model : null).toEqual({ id: MODEL_ID, providerID: PROVIDER_ID, variant: "default" });
    evidence.recordAssertionEvidence(
      "Agents read a session's model and effort back through session.read",
      `session.read for ${createdId} returned model=${JSON.stringify(read?.model)}; no UI command was needed.`,
      JSON.stringify(read?.model) === JSON.stringify(requested),
    );
  });
});
