import { expect } from "vitest";
import { eventually, needs, test } from "@openwork/testkit";
import { bootManagedInference } from "../worlds/managed-inference.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function events(text: string): Record<string, unknown>[] {
  return text.split(/\r?\n/).filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6))).filter(record);
}

test("managed responses preserve completion, partial work, and cancellation", { timeout: 180000 }, async ({ place, evidence }) => {
  needs({ placement: "local" });
  await using world = await bootManagedInference(place);
  const { key, memberId, providerKey } = world.identity;
  const model = "z-ai/glm-5.2";
  const message = { role: "user", content: "private fixture prompt" };
  const chat = (body: Record<string, unknown> = {}, signal: AbortSignal = AbortSignal.timeout(8000), bearer = key) => fetch(`${world.url}/api/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    signal, body: JSON.stringify({ model, messages: [message], stream: true, ...body }),
  });
  const claim = (name: string, detail: string) => evidence.recordAssertionEvidence(name, detail, true);
  const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { key: { type: "string" } } } } }];

  const success = await chat();
  const text = await success.text();
  expect(success.status).toBe(200);
  expect(text.match(/Complete café/g)).toHaveLength(1);
  expect(text.match(/\[DONE\]/g)).toHaveLength(1);
  expect(events(text).find((event) => event.usage)?.usage).toMatchObject({ total_tokens: 24, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 3 } });
  expect(world.witness.requests[0]?.credential).toBe(`Bearer ${providerKey}`);
  expect(world.witness.requests[0]?.body).toMatchObject({ model, user: memberId });
  expect(success.headers.get("x-openwork-request-id")).toBe(world.witness.requests[0]?.body.session_id);
  claim("Successful responses retain text and final usage once", "The real gateway preserves fragmented UTF-8, final usage including a repeated terminal choice, one completion marker, and the server-assigned request identity.");

  let reference: Record<string, unknown>[] | undefined;
  for (const mode of ["first-frame", "first-frame-json", "first-frame-utf8", "first-frame-delimiter", "first-frame-bytes"] as const) {
    world.witness.mode(mode);
    const count = world.witness.requests.length;
    const response = await chat({ tools });
    const output = await response.text();
    expect(response.status, mode).toBe(200);
    expect(output.match(/\[DONE\]/g), mode).toHaveLength(1);
    expect(output, mode).not.toContain(": processing");
    expect(output, mode).not.toContain('"error"');
    expect(output.match(/Complete café/g), mode).toHaveLength(1);
    const parsed = events(output);
    if (reference) expect(parsed, mode).toEqual(reference);
    else reference = parsed;
    const deltas = parsed.flatMap((event) => Array.isArray(event.choices) ? event.choices.filter(record) : [])
      .flatMap((choice) => record(choice.delta) ? [choice.delta] : []);
    const calls = deltas.flatMap((delta) => Array.isArray(delta.tool_calls) ? delta.tool_calls.filter(record) : []);
    expect(calls.flatMap((call) => record(call.function) ? [call.function.arguments] : []).join(""), mode).toBe('{"key":"value"}');
    expect(output, mode).toContain("Fixture reasoning");
    expect(parsed.find((event) => event.usage)?.usage, mode).toMatchObject({ total_tokens: 24 });
    expect(world.witness.requests.length, mode).toBe(count + 1);
  }
  claim("The first response frame survives arbitrary transport splits", "Heartbeat-free JSON, UTF-8, delimiter and bytewise splits match the unsplit response: text, reasoning, tool fragments and usage remain intact, with one attempt and one DONE.");

  world.witness.mode("success");
  const history = [message, { role: "assistant", content: null, tool_calls: [{ id: "call_failed", type: "function", function: { name: "lookup", arguments: '{"key":' } }] }, { role: "tool", tool_call_id: "call_failed", content: "Invalid arguments; no tool was executed." }];
  const controls = { messages: history, tools, reasoning: { effort: "medium" }, provider: { allow_fallbacks: true }, transforms: ["middle-out"], max_tokens: 131073 };
  expect(await (await chat(controls)).text()).toContain("[DONE]");
  const forwarded = world.witness.requests.at(-1)?.body;
  if (!forwarded) throw new Error("Missing forwarded request");
  const { user, trace, session_id, ...providerInput } = forwarded;
  expect(providerInput).toEqual({ model, stream: true, ...controls });
  expect(user).toBe(memberId);
  expect(trace).toMatchObject({ openwork_request_id: session_id, org_membership_id: memberId });
  claim("Request settings and tool-error history are not rewritten", "The gateway retains the chosen model, reasoning, routing preferences, transforms and output limits, including malformed historical arguments followed by their matching tool error. It does not substitute defaults or impose a new request contract.");

  world.witness.mode("length-tools");
  const lengthText = await (await chat({ tools })).text();
  expect(lengthText).toContain('"finish_reason":"length"');
  expect(lengthText).toContain("[DONE]");
  expect(lengthText).not.toContain('"error"');
  expect(events(lengthText).find((event) => event.usage)?.usage).toEqual({ total_tokens: 24 });
  const lengthCalls = events(lengthText).flatMap((event) => Array.isArray(event.choices) ? event.choices.filter(record) : [])
    .flatMap((choice) => record(choice.delta) && Array.isArray(choice.delta.tool_calls) ? choice.delta.tool_calls : []);
  expect(lengthCalls).toEqual([{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"key":' } }]);
  world.witness.mode("length-json");
  const lengthJson = await chat({ stream: false });
  expect(lengthJson.status).toBe(200);
  expect(await lengthJson.json()).toMatchObject({ choices: [{ finish_reason: "length", message: { tool_calls: [{ function: { arguments: "{" } }] } }], usage: { total_tokens: 24 } });
  claim("Token-limit endings are not confused with broken transport", "Streaming and JSON length endings retain incomplete tool arguments, the provider's terminal reason and usage. The tool consumer, not the transport relay, decides whether a tool can execute.");

  for (const mode of ["two-choices", "two-json"] as const) {
    world.witness.mode(mode);
    const count = world.witness.requests.length;
    const response = await chat({ n: 2, stream: mode === "two-choices" });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Choice 0");
    expect(body).toContain("Choice 1");
    expect(body).not.toContain('"error"');
    if (mode === "two-choices") expect(body.match(/\[DONE\]/g)).toHaveLength(1);
    else expect(JSON.parse(body).choices.map((choice: { index: number }) => choice.index)).toEqual([0, 1]);
    expect(world.witness.requests.length).toBe(count + 1);
    expect(world.witness.requests.at(-1)?.body.n).toBe(2);
  }
  claim("Requested completion choices are preserved in both protocols", "A controlled provider honoring n=2 returns both choices through JSON and SSE, including interleaved terminal choices, without retries. This proves relay compatibility, not live-provider support for n.");

  for (const mode of ["interrupted", "malformed", "extra-choice", "stall", "partial-frame-stall"] as const) {
    world.witness.mode(mode);
    const count = world.witness.requests.length;
    const deadline = AbortSignal.timeout(5000);
    const response = await chat({}, deadline);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('"error"');
    expect(body).not.toContain("[DONE]");
    expect(body).not.toContain("Unrequested second choice");
    if (mode === "partial-frame-stall") expect(body).not.toContain('"choices"');
    else expect(body).toContain("Partial");
    if (mode.includes("stall")) expect(body).toContain("upstream_timeout");
    expect(deadline.aborted).toBe(false);
    expect(world.witness.requests.length).toBe(count + 1);
  }
  claim("Broken and idle streams preserve only valid partial output", "Premature EOF, malformed frames and unrequested choices emit an error without DONE. Idle streams time out at the gateway before the independent client deadline, including a first frame with no complete output.");

  world.witness.mode("heartbeat");
  const heartbeatStarted = Date.now();
  const heartbeat = await (await chat()).text();
  expect(Date.now() - heartbeatStarted).toBeGreaterThanOrEqual(3000);
  expect(heartbeat).toContain("Complete");
  expect(heartbeat).toContain("[DONE]");
  expect(heartbeat).not.toContain('"error"');
  claim("Transport progress does not require visible model output", "A provider sending heartbeats continues beyond three idle periods and then completes; only lack of transport progress triggers the stream-idle timeout.");

  for (const mode of ["partial-frame-stall", "stall"] as const) {
    world.witness.mode(mode);
    const count = world.witness.requests.length;
    const abort = new AbortController();
    let seen = "";
    const reading = (async () => {
      const response = await chat({}, AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]));
      if (!response.body) throw new Error("Missing response body");
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return;
          seen += new TextDecoder().decode(chunk.value);
        }
      } finally { reader.releaseLock(); }
    })();
    void reading.catch(() => {});
    try {
      await eventually(() => mode === "stall" ? seen.includes("Partial") : world.witness.requests[count]?.partialFrameAt != null, { within: 2000, intervalMs: 10 });
      const request = world.witness.requests[count];
      if (!request) throw new Error("Missing cancellation witness");
      expect(request.cancelled).toBe(false);
      if (mode === "partial-frame-stall") expect(seen).toBe("");
      const cancelledAt = Date.now();
      abort.abort();
      await eventually(() => request.cancelled, { within: 650, intervalMs: 10 });
      expect(Date.now() - cancelledAt).toBeLessThan(700);
      expect(request.cancelled).toBe(true);
      expect(seen).not.toContain("[DONE]");
      expect(world.witness.requests.length).toBe(count + 1);
    } finally {
      abort.abort();
      await reading.catch(() => {});
    }
  }
  claim("Cancellation closes upstream before idle expiry", "Client abort closes the real provider connection within 700 ms of the abort instant, before the 1000 ms idle deadline, both before any downstream bytes and after partial text. No completion or second attempt is produced.");

  for (const [mode, code] of [
    ["header-stall", "upstream_timeout"],
    ["json-stall", "upstream_timeout"],
    ["unfinished-json", "upstream_incomplete"],
    ["malformed-json", "upstream_malformed_response"],
  ] as const) {
    world.witness.mode(mode);
    const deadline = AbortSignal.timeout(5000);
    const count = world.witness.requests.length;
    const response = await chat({ stream: false }, deadline);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(deadline.aborted).toBe(false);
    expect(world.witness.requests.length).toBe(count + 1);
  }
  for (const [mode, status] of [["rate-limit", 429], ["access-denied", 401], ["capability-400", 400], ["capability-422", 422]] as const) {
    world.witness.mode(mode);
    const count = world.witness.requests.length;
    const response = await chat();
    expect(response.status).toBe(status);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(await response.text()).not.toContain("private provider");
    expect(world.witness.requests.length).toBe(count + 1);
  }
  claim("Timeout and provider failures remain safe and distinguishable", "Real slow headers and JSON bodies produce upstream_timeout, malformed/unfinished JSON has separate categories, provider failures preserve HTTP status and Retry-After, and every case makes one generation attempt.");

  world.witness.mode("engine-tool");
  const engine = await world.bootEngine();
  const session = await engine.engine("POST", "/session", { title: "Managed response tool task" });
  if (!record(session) || typeof session.id !== "string") throw new Error("Missing engine session");
  const result = await engine.engine("POST", `/session/${session.id}/message`, { model: { providerID: "openwork", modelID: model }, parts: [{ type: "text", text: "Read the managed inference fixture and finish." }] });
  expect(result).not.toHaveProperty("info.error");
  const transcript = await engine.engine("GET", `/session/${session.id}/message`);
  const parts = Array.isArray(transcript) ? transcript.filter(record).flatMap((message) => Array.isArray(message.parts) ? message.parts.filter(record) : []) : [];
  expect(parts.filter((part) => part.type === "tool")).toHaveLength(1);
  expect(parts.find((part) => part.type === "tool")).toMatchObject({ tool: "read", state: { status: "completed", output: expect.stringContaining("Managed inference tool result") } });
  expect(parts.filter((part) => part.type === "text" && part.text === "Complete café")).toHaveLength(1);
  world.witness.mode("interrupted");
  const interrupted = await engine.engine("POST", "/session", { title: "Interrupted managed task" });
  if (!record(interrupted) || typeof interrupted.id !== "string") throw new Error("Missing interrupted session");
  await engine.engine("POST", `/session/${interrupted.id}/message`, { model: { providerID: "openwork", modelID: model }, parts: [{ type: "text", text: "Keep the partial result." }] });
  const saved = await engine.engine("GET", `/session/${interrupted.id}/message`);
  expect(saved).toEqual(expect.arrayContaining([expect.objectContaining({ info: expect.objectContaining({ role: "assistant", error: expect.anything() }), parts: expect.arrayContaining([expect.objectContaining({ type: "text", text: "Partial" })]) })]));
  const statuses = await engine.engine("GET", "/session/status");
  expect(record(statuses) ? statuses[interrupted.id] : null).not.toMatchObject({ type: "busy" });
  claim("The real engine persists successful tools and interrupted work", "With a baseline model configuration, OpenCode executes Read once and persists its result. Premature provider EOF persists a session error beside partial text, verified by transcript readback, and leaves the busy state. This is not catalog-delivery or billing proof.");

  world.witness.mode("success");
  const beforeInvalid = world.witness.requests.length;
  expect((await chat({}, AbortSignal.timeout(5000), "invalid-key")).status).toBe(401);
  expect((await chat({ model: "unknown/model" })).status).toBe(404);
  expect((await chat({ models: ["another/model"] })).status).toBe(400);
  expect(world.witness.requests.length).toBe(beforeInvalid);
  expect(world.logs()).not.toContain("private fixture prompt");
  expect(world.logs()).not.toContain("private provider error payload");
  expect(world.logs()).not.toContain(key);
  expect(world.logs()).not.toContain(providerKey);
  claim("The existing routing boundary and content-free diagnostics remain intact", "Invalid credentials, unknown models and alternate-model selection do not reach upstream. Real service stdout/stderr excludes fixture prompt, private provider error, member bearer and provider credential sentinels; structured reporter behavior has separate supporting tests.");
});
