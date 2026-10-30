import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import { autoRouterIdFromModel, autoRouterModelId, autoRouterThinkingLevels, type AutoRouterThinkingLevel } from "@openwork/types/den/auto-router"
import { anthropicJsonToChat, anthropicStreamToChat, claudeTakesEffort, toAnthropicBody } from "../src/auto-router/anthropic.js"
import { createMemoryReasoningStore } from "../src/auto-router/reasoning-store.js"
import { injectRouteIntoChatStream, readAutoPrompt, toOpenAiChatBody, type AutoRouteInfo } from "../src/auto-router/chat.js"
import { annotateChatError, annotateChatStreamErrors, autoRouteNote } from "../src/auto-router/handler.js"
import { clearAutoTurnChoices, decideAutoRoute, fallbackDecision, jevTasks, thinkingLevelFor, type AutoCandidate, type TurnChoice } from "../src/auto-router/decide.js"
import { JEV_THINKING_KEY, jevRequestBody, readJevScores, type AskJev, type JevScores } from "../src/auto-router/jev.js"

const route: AutoRouteInfo = { provider: "anthropic", model: "claude-opus-5", thinking: "high", reason: "jev" }

const ALL_LEVELS: AutoRouterThinkingLevel[] = ["default", "low", "medium", "high", "max"]

const candidates: AutoCandidate[] = [
  { modelIndex: 0, routeId: "arm_sonnet", modelName: "Claude Sonnet 5", tasks: ["Writing", "Code review"], thinkingLevels: ALL_LEVELS },
  { modelIndex: 1, routeId: "arm_haiku", modelName: "Claude Haiku 5", tasks: ["Quick questions"], thinkingLevels: ["default", "low", "medium", "high"] },
  { modelIndex: 2, routeId: "arm_opus", modelName: "Claude Opus 5", tasks: ["Debugging", "code review", "Planning"], thinkingLevels: ALL_LEVELS },
]

/** Jev's answer from task names to scores (0..1); keys are resolved from the request. */
function jevAnswering(byName: Record<string, number>, thinking: number | null = 0.5, seen?: { names: string[] }[]): AskJev {
  return async ({ tasks }) => {
    seen?.push({ names: tasks.map((task) => task.name) })
    const scores: JevScores = { tasks: new Map(), thinking, model: "jev-1" }
    for (const task of tasks) if (task.name in byName) scores.tasks.set(task.key, byName[task.name] ?? 0)
    return scores
  }
}

function stream(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Split mid-event to prove buffering.
      const bytes = new TextEncoder().encode(text)
      controller.enqueue(bytes.slice(0, 37))
      controller.enqueue(bytes.slice(37))
      controller.close()
    },
  })
}

async function readAll(body: ReadableStream<Uint8Array>) {
  return new Response(body).text()
}

function dataEvents(text: string) {
  return text.split("\n\n").flatMap((event) => event.startsWith("data: ") ? [event.slice(6)] : [])
}

beforeEach(() => {
  clearAutoTurnChoices()
})

test("Smart model ids carry the router id", () => {
  assert.equal(autoRouterModelId("aur_1"), "openwork-smart-aur_1")
  assert.equal(autoRouterIdFromModel("openwork-smart-aur_1"), "aur_1")
  assert.equal(autoRouterIdFromModel("openwork-smart-"), null)
  assert.equal(autoRouterIdFromModel("openwork-auto"), null)
  assert.equal(autoRouterIdFromModel(42), null)
})

test("the fallback is the first model the member can use, at the provider's default thinking", () => {
  const decision = fallbackDecision(candidates)
  assert.equal(decision?.candidate.routeId, "arm_sonnet")
  assert.equal(decision?.thinkingLevel, "default")
  assert.equal(decision?.reason, "fallback")
  assert.equal(fallbackDecision([candidates[2]!, candidates[1]!])?.candidate.routeId, "arm_haiku")
  assert.equal(fallbackDecision([]), null)
})

test("each distinct task is one Jev question, shared tasks once (case-insensitive)", () => {
  const { tasks } = jevTasks(candidates)
  assert.deepEqual(tasks, [
    { key: "task_1", name: "Writing" },
    { key: "task_2", name: "Code review" },
    { key: "task_3", name: "Quick questions" },
    { key: "task_4", name: "Debugging" },
    { key: "task_5", name: "Planning" },
  ])
})

test("the model whose tasks score highest in total answers, even against a single stronger match", async () => {
  // Haiku has the single best match (0.9), but Opus's two matches add up to more (0.7 + 0.6).
  const decision = await decideAutoRoute({
    candidates,
    prompt: "this crashes, help me fix it and plan the refactor",
    context: null,
    continuation: false,
    turnKey: "t1",
    askJev: jevAnswering({ "Quick questions": 0.9, Debugging: 0.7, Planning: 0.6 }),
  })
  assert.equal(decision?.candidate.routeId, "arm_opus")
  assert.equal(decision?.reason, "jev")
  assert.ok(Math.abs((decision?.totals?.get("arm_opus") ?? 0) - 1.3) < 1e-9)
  assert.equal(decision?.totals?.get("arm_haiku"), 0.9)
})

test("a task shared by two models counts for both; ties go to the model listed first", async () => {
  const decision = await decideAutoRoute({ candidates, prompt: "review this PR", context: null, continuation: false, turnKey: null, askJev: jevAnswering({ "Code review": 1 }) })
  assert.equal(decision?.totals?.get("arm_sonnet"), 1)
  assert.equal(decision?.totals?.get("arm_opus"), 1)
  assert.equal(decision?.candidate.routeId, "arm_sonnet")
})

test("Jev's thinking score picks the closest level the chosen model allows", () => {
  assert.equal(thinkingLevelFor(0, ALL_LEVELS), "low", "no none level: the closest is low")
  assert.equal(thinkingLevelFor(0, ["default", "none", "low"]), "none")
  assert.equal(thinkingLevelFor(0.34, ALL_LEVELS), "low")
  assert.equal(thinkingLevelFor(0.66, ALL_LEVELS), "medium")
  assert.equal(thinkingLevelFor(1, ALL_LEVELS), "high")
  assert.equal(thinkingLevelFor(1, ["default", "low", "max"]), "max", "ties go to more reasoning")
  assert.equal(thinkingLevelFor(0.66, ["default", "low", "high"]), "high")
  assert.equal(thinkingLevelFor(1, ["default"]), "default", "a model without effort levels")
  assert.equal(thinkingLevelFor(null, ALL_LEVELS), "default")
})

test("the chosen model runs at the thinking level Jev scored", async () => {
  const decision = await decideAutoRoute({ candidates, prompt: "plan a migration", context: null, continuation: false, turnKey: null, askJev: jevAnswering({ Planning: 1 }, 1) })
  assert.equal(decision?.candidate.routeId, "arm_opus")
  assert.equal(decision?.thinkingLevel, "high")
})

test("a single usable model only asks Jev how much to think", async () => {
  const seen: { names: string[] }[] = []
  const decision = await decideAutoRoute({ candidates: [candidates[1]!], prompt: "hi", context: null, continuation: false, turnKey: null, askJev: jevAnswering({}, 0, seen) })
  assert.deepEqual(seen, [{ names: [] }])
  assert.equal(decision?.candidate.routeId, "arm_haiku")
  assert.equal(decision?.thinkingLevel, "low")
  assert.equal(decision?.reason, "jev")
})

test("a continuation of the same turn reuses the model and thinking without asking Jev", async () => {
  let calls = 0
  const inner = jevAnswering({ Planning: 1 }, 1)
  const askJev: AskJev = async (input) => { calls++; return inner(input) }
  await decideAutoRoute({ candidates, prompt: "design a system", context: null, continuation: false, turnKey: "turn", askJev })
  const next = await decideAutoRoute({ candidates, prompt: "design a system", context: null, continuation: true, turnKey: "turn", askJev })
  assert.equal(calls, 1)
  assert.equal(next?.reason, "turn")
  assert.equal(next?.candidate.routeId, "arm_opus")
  assert.equal(next?.thinkingLevel, "high")
})

test("Jev failing, answering nothing, or an empty prompt falls back to the first model", async () => {
  const errors: unknown[] = []
  const failing: AskJev = async () => { throw new Error("jev_http_500") }
  const failed = await decideAutoRoute({ candidates, prompt: "hi", context: null, continuation: false, turnKey: null, askJev: failing, onJevError: (error) => errors.push(error) })
  assert.equal(failed?.reason, "fallback")
  assert.equal(failed?.candidate.routeId, "arm_sonnet")
  assert.equal(errors.length, 1)
  const unconfigured: AskJev = async () => null
  assert.equal((await decideAutoRoute({ candidates, prompt: "hi", context: null, continuation: false, turnKey: null, askJev: unconfigured }))?.reason, "fallback")
  let asked = false
  const never: AskJev = async () => { asked = true; return null }
  const empty = await decideAutoRoute({ candidates, prompt: "  ", context: null, continuation: false, turnKey: null, askJev: never })
  assert.equal(asked, false)
  assert.equal(empty?.candidate.routeId, "arm_sonnet")
})

test("the Jev request has one Score question per task plus thinking, and never provider or model ids", () => {
  const body = jevRequestBody({
    prompt: "fix the failing test",
    context: "earlier",
    model: "jev-latest",
    tasks: [{ key: "task_1", name: "Debugging" }, { key: "task_2", name: "Code review" }],
  })
  assert.deepEqual(Object.keys(body.questions), ["task_1", "task_2", JEV_THINKING_KEY])
  assert.equal(body.questions.task_1?.type, "score")
  assert.equal(body.questions.task_1?.criteria.length, 3)
  assert.match(JSON.stringify(body.questions.task_2), /Code review/)
  assert.equal(body.questions[JEV_THINKING_KEY]?.criteria.length, 4)
  assert.equal(body.state.latest_request, "fix the failing test")
  assert.equal(body.state.earlier_conversation, "earlier")
  assert.doesNotMatch(JSON.stringify(body), /ipr_|gwm_|claude/)
})

test("Jev's Score answers are normalized to 0..1", () => {
  const tasks = [{ key: "task_1", name: "Debugging" }, { key: "task_2", name: "Writing" }]
  const scores = readJevScores({
    model: "jev-1.13.0",
    answers: {
      task_1: { type: "score", score: 1.5, confidence: 0.4 },
      task_2: { type: "score", score: 0 },
      [JEV_THINKING_KEY]: { type: "score", score: 3 },
    },
  }, tasks)
  assert.equal(scores?.tasks.get("task_1"), 0.75)
  assert.equal(scores?.tasks.get("task_2"), 0)
  assert.equal(scores?.thinking, 1)
  assert.equal(scores?.model, "jev-1.13.0")
  assert.equal(readJevScores({ answers: {} }, tasks), null)
  assert.equal(readJevScores("nope", tasks), null)
})

test("the prompt is the latest user message; tool results continue the turn", () => {
  const first = readAutoPrompt({ messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: [{ type: "text", text: "list files" }] },
  ] })
  assert.equal(first.prompt, "list files")
  assert.equal(first.continuation, false)
  const later = readAutoPrompt({ messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: [{ type: "text", text: "list files" }] },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "a.ts" },
  ] })
  assert.equal(later.prompt, "list files")
  assert.equal(later.continuation, true)
  assert.equal(later.turnFingerprint, first.turnFingerprint)
})

test("OpenAI routes get the chosen reasoning effort and the member's alias", () => {
  const body = toOpenAiChatBody({ model: "openwork-auto", messages: [], reasoning_effort: "low" }, { model: "gwm_x", thinkingLevel: "high", reasoningStyle: "reasoning_effort" })
  assert.equal(body.model, "gwm_x")
  assert.equal(body.reasoning_effort, "high")
  const plain = toOpenAiChatBody({ model: "openwork-auto", messages: [] }, { model: "gwm_x", thinkingLevel: "default", reasoningStyle: "reasoning_effort" })
  assert.equal(plain.reasoning_effort, undefined)
  const openrouter = toOpenAiChatBody({ model: "openwork-auto", messages: [] }, { model: "gwm_x", thinkingLevel: "medium", reasoningStyle: "openrouter" })
  assert.deepEqual(openrouter.reasoning, { effort: "medium" })
})

test("a chat request becomes a Messages request with tools, results and effort", () => {
  const body = toAnthropicBody({
    model: "openwork-auto",
    stream: true,
    temperature: 0.2,
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: [{ type: "text", text: "read a.ts" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    ],
    tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    tool_choice: "auto",
  }, { model: "gwm_x", upstreamModel: "claude-opus-5", thinkingLevel: "high", maxOutputTokens: 64000 })
  assert.deepEqual(body.system, [{ type: "text", text: "You are helpful." }])
  assert.equal(body.max_tokens, 64000)
  assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" })
  assert.deepEqual(body.output_config, { effort: "high" })
  assert.equal(body.temperature, undefined, "thinking requires the default temperature")
  assert.deepEqual(body.tools, [{ name: "read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }])
  assert.deepEqual(body.tool_choice, { type: "auto" })
  assert.deepEqual(body.messages, [{ role: "user", content: [
    { type: "text", text: "read a.ts" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
  ] }])
})

test("a tool-use turn without its signed thinking thinks off only where the model allows it", () => {
  const messages = [
    { role: "user", content: "read a.ts" },
    { role: "assistant", content: "", tool_calls: [{ id: "toolu_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.ts\"}" } }] },
    { role: "tool", tool_call_id: "toolu_1", content: "export {}" },
  ]
  const body = toAnthropicBody({ messages }, { model: "gwm_x", upstreamModel: "claude-opus-5", thinkingLevel: "high", maxOutputTokens: null, thinkingLevels: ["default", "none", "high"] })
  assert.deepEqual(body.thinking, { type: "disabled" })
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "text", text: "read a.ts" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "export {}" }] },
  ])
})

test("a model that only takes adaptive thinking never gets thinking disabled; the unsigned turn becomes text", () => {
  const messages = [
    { role: "user", content: "read a.ts" },
    { role: "assistant", content: "", tool_calls: [{ id: "toolu_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.ts\"}" } }] },
    { role: "tool", tool_call_id: "toolu_1", content: "export {}" },
  ]
  for (const thinkingLevel of ["medium", "default"] as const) {
    const body = toAnthropicBody({ messages }, { model: "gwm_x", upstreamModel: "claude-opus-5-5", thinkingLevel, maxOutputTokens: null, thinkingLevels: ["default", "low", "medium", "high"] })
    assert.notDeepEqual(body.thinking, { type: "disabled" })
    assert.deepEqual(body.messages, [
      { role: "user", content: [{ type: "text", text: "read a.ts" }] },
      { role: "assistant", content: [{ type: "text", text: "[Called the read tool with {\"path\":\"a.ts\"}]" }] },
      { role: "user", content: [{ type: "text", text: "[Result of the read tool]\nexport {}" }] },
    ])
  }
  const medium = toAnthropicBody({ messages }, { model: "gwm_x", upstreamModel: "claude-opus-5-5", thinkingLevel: "medium", maxOutputTokens: null, thinkingLevels: ["default", "medium"] })
  assert.deepEqual(medium.thinking, { type: "adaptive", display: "summarized" })
  assert.deepEqual(medium.output_config, { effort: "medium" })
  // Earlier turns keep their structured tool calls.
  const later = toAnthropicBody({ messages: [...messages, { role: "assistant", content: "Done." }, { role: "user", content: "next" }] }, { model: "gwm_x", upstreamModel: "claude-opus-5-5", thinkingLevel: "medium", maxOutputTokens: null, thinkingLevels: ["default", "medium"] })
  assert.match(JSON.stringify(later.messages), /tool_use/)
})

test("a Messages stream becomes a chat stream, and its thinking is replayed on the next request", async () => {
  const sse = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, cache_read_input_tokens: 5 } } })}`,
    ": processing",
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me look." } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } })}`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Reading." } })}`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_9", name: "read" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"path\":" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "\"a.ts\"}" } })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } })}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
    "",
  ].join("\n\n")
  const store = createMemoryReasoningStore()
  const remembered: Promise<void>[] = []
  const text = await readAll(anthropicStreamToChat(stream(sse), route, (ids, payload) => { remembered.push(store.remember("org_1", ids, payload)) }))
  await Promise.all(remembered)
  assert.match(text, /^: processing$/m)
  const events = dataEvents(text)
  assert.equal(events.at(-1), "[DONE]")
  const chunks = events.slice(0, -1).map((event) => JSON.parse(event))
  assert.deepEqual(chunks[0].openwork_route, route)
  assert.equal(chunks[0].choices[0].delta.role, "assistant")
  assert.equal(chunks[1].choices[0].delta.reasoning_content, "Let me look.")
  assert.equal(chunks[2].choices[0].delta.content, "Reading.")
  assert.equal(chunks[3].choices[0].delta.tool_calls[0].id, "toolu_9")
  const args = chunks.flatMap((chunk) => chunk.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments ?? []).join("")
  assert.equal(args, "{\"path\":\"a.ts\"}")
  assert.equal(chunks.at(-2).choices[0].finish_reason, "tool_calls")
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 15, completion_tokens: 7, total_tokens: 22, prompt_tokens_details: { cached_tokens: 5 } })

  const next = toAnthropicBody({ messages: [
    { role: "user", content: "read a.ts" },
    { role: "assistant", content: "Reading.", tool_calls: [{ id: "toolu_9", type: "function", function: { name: "read", arguments: "{\"path\":\"a.ts\"}" } }] },
    { role: "tool", tool_call_id: "toolu_9", content: "export {}" },
  ] }, { model: "gwm_x", upstreamModel: "claude-opus-5", thinkingLevel: "high", maxOutputTokens: null, reasoning: await store.recall("org_1", ["toolu_9"]) })
  assert.deepEqual(next.output_config, { effort: "high" })
  const assistant = Array.isArray(next.messages) ? next.messages[1] : null
  assert.deepEqual(assistant?.content[0], { type: "thinking", thinking: "Let me look.", signature: "sig" })
})

test("a Messages error event becomes a chat error", async () => {
  const text = await readAll(anthropicStreamToChat(stream(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`), route))
  assert.deepEqual(JSON.parse(dataEvents(text)[0] ?? "null"), { error: { message: "Overloaded", type: "overloaded_error", code: "overloaded_error" } })
})

test("a complete Messages response becomes a chat completion", () => {
  const chat = anthropicJsonToChat({ id: "msg_2", content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } }, route)
  assert.deepEqual(chat.choices, [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }])
  assert.deepEqual(chat.openwork_route, route)
})

test("OpenAI streams get the route on their first chunk only", async () => {
  const sse = `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "a" } }] })}\n\ndata: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "b" } }] })}\n\ndata: [DONE]\n\n`
  const events = dataEvents(await readAll(injectRouteIntoChatStream(stream(sse), route)))
  assert.deepEqual(JSON.parse(events[0] ?? "null").openwork_route, route)
  assert.equal(JSON.parse(events[1] ?? "null").openwork_route, undefined)
  assert.equal(events[2], "[DONE]")
})

test("effort is only sent to Claude models that take it", () => {
  assert.equal(claudeTakesEffort("claude-opus-5"), true)
  assert.equal(claudeTakesEffort("claude-sonnet-4-6"), true)
  assert.equal(claudeTakesEffort("claude-sonnet-4-5"), false)
  assert.equal(claudeTakesEffort("claude-3-7-sonnet"), false)
  assert.equal(claudeTakesEffort("anthropic.claude-3-7-sonnet-20250219-v1:0"), false)
  assert.equal(claudeTakesEffort("claude-sonnet-4-5-20250929"), false)
  assert.equal(claudeTakesEffort("claude-opus-4-6-20260101"), true)
})

test("a model allows default plus its catalog effort levels, in order", () => {
  assert.deepEqual(autoRouterThinkingLevels("claude-opus-5", { reasoning: true, reasoning_options: [{ type: "effort", values: ["max", "low", "high", "bogus"] }] }), ["default", "low", "high", "max"])
  assert.deepEqual(autoRouterThinkingLevels("claude-sonnet-4-5", { reasoning: true, reasoning_options: [{ type: "effort", values: ["low"] }] }), ["default"])
  assert.deepEqual(autoRouterThinkingLevels("gpt-5", { reasoning: false, reasoning_options: [{ type: "effort", values: ["low"] }] }), ["default"])
})

test("a continuation on another gateway instance keeps the turn's model and thinking from the shared store", async () => {
  const shared = new Map<string, TurnChoice>()
  const store = { recall: async (key: string) => shared.get(key) ?? null, remember: async (key: string, choice: TurnChoice) => { shared.set(key, choice) } }
  let calls = 0
  const inner = jevAnswering({ "Quick questions": 1 }, 0.66)
  const askJev: AskJev = async (input) => { calls++; return inner(input) }
  await decideAutoRoute({ candidates, prompt: "what time is it in Tokyo", context: null, continuation: false, turnKey: "turn-shared", askJev, shared: store })
  clearAutoTurnChoices() // as if the next request landed on another instance
  const next = await decideAutoRoute({ candidates, prompt: "what time is it in Tokyo", context: null, continuation: true, turnKey: "turn-shared", askJev, shared: store })
  assert.equal(calls, 1)
  assert.equal(next?.reason, "turn")
  assert.equal(next?.candidate.routeId, "arm_haiku")
  assert.equal(next?.thinkingLevel, "medium")
})

test("every error says which model Smart chose", async () => {
  const chosen = { ...route, name: "Claude Opus 5.5", thinking: "medium" as const }
  assert.equal(autoRouteNote(chosen), "Smart chose Claude Opus 5.5 · Medium thinking.")
  assert.equal(autoRouteNote({ ...chosen, thinking: "default" }), "Smart chose Claude Opus 5.5.")
  const json = annotateChatError({ error: { message: "Overloaded", type: "overloaded_error" } }, chosen)
  assert.deepEqual(json.error, { message: "Overloaded (Smart chose Claude Opus 5.5 · Medium thinking.)", type: "overloaded_error" })
  assert.deepEqual(json.openwork_route, chosen)
  const text = await new Response(annotateChatStreamErrors(stream(`data: ${JSON.stringify({ choices: [{ delta: { content: "a" } }] })}\n\ndata: ${JSON.stringify({ error: { message: "Boom", type: "api_error" } })}\n\n`), chosen)).text()
  const events = dataEvents(text).map((event) => JSON.parse(event))
  assert.equal(events[0].choices[0].delta.content, "a")
  assert.equal(events[1].error.message, "Boom (Smart chose Claude Opus 5.5 · Medium thinking.)")
})
