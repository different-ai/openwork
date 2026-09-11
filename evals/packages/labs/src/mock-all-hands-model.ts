import { createServer } from "node:http";
import { record, type ToolReceipt } from "./scripted-tool-model.ts";

export const eventOutcome = {
  summary: "Scout and Editor reviewed launch readiness without external action.",
  decisions: ["Keep the launch review read-only."],
  accomplishments: ["Both participants contributed their current assessment."],
  openQuestions: ["Which remaining blocker needs a separate assignment?"],
  followUps: ["Ask the person to choose the next assignment."],
};

export const weeklyReview = {
  title: "Weekly research review",
  goal: "Review current research and identify next decisions.",
  workingPrompt: "Compare research notes, state uncertainty, and propose next steps without external action.",
  revisedGoal: "Resolve the highest-priority research question.",
};
export const weeklyPrompts = {
  create: "Set up a weekly research review called Weekly research review with Scout and you as lead. Start in about two minutes, use UTC, and repeat for two weeks. The goal is to review current research and identify next decisions. Each session should compare research notes, state uncertainty, and propose next steps without external action.",
  pause: "Pause that review.",
  update: "Change the goal to resolve the highest-priority research question and resume future sessions.",
  run: "Run another session now.",
};
export const weeklyReplies = {
  create: "The weekly research review is scheduled.",
  pause: "The review is paused. Its completed session is kept.",
  update: "The review goal is updated and future sessions are resumed.",
  run: "Another review session is queued.",
};
export const weeklyOutcomes = [
  { summary: "First research review completed; evidence ownership and draft timing remain open.", decisions: ["Keep the review read-only."], accomplishments: ["Editor and Scout compared their research notes."], openQuestions: ["Who should verify the priority evidence?", "When should the next draft be reviewed?"], followUps: ["Ask Editor to verify the priority evidence before the next review."] },
  { summary: "Second research review resolved evidence ownership; draft timing is still open.", decisions: ["Editor will verify the priority evidence."], accomplishments: ["Resolved the evidence-owner question from the first review."], openQuestions: ["When should the next draft be reviewed?"], followUps: ["Ask the person to choose the next draft review time."] },
];

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.map((part) => record(part) && typeof part.text === "string" ? part.text : "").join("\n") : "";
}

/** A local model witness: real engine requests and streaming, no provider spend. */
export async function allHandsModel() {
  const prompts: string[] = [];
  const requests: { model: string; speaker: string; phase: string; facilitator: boolean; prompt: string }[] = [];
  const calls: Omit<ToolReceipt, "output">[] = [];
  const receipts: ToolReceipt[] = [];
  const errors: string[] = [];
  let weekly = false;
  const result = (id: string): Record<string, unknown> => {
    const receipt = receipts.find((item) => item.id === id);
    if (!receipt) throw new Error(`Missing native receipt: ${id}`);
    const value: unknown = JSON.parse(receipt.output);
    if (!record(value)) throw new Error(`Invalid native receipt: ${id}`);
    return value;
  };
  const eventFrom = (id: string) => {
    const event = result(id).event;
    if (!record(event)) throw new Error(`Missing Event definition in ${id}`);
    return event;
  };
  const plans = {
    create: [
      { id: "weekly-calendar", name: "coworker_workplace_calendar", args: () => ({}) },
      { id: "weekly-create", name: "coworker_event_create", args: () => {
        const observedAt = result("weekly-calendar").observedAt;
        if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) throw new Error("Native calendar did not return its clock");
        const startsAt = Math.ceil((observedAt + 90_000) / 60_000) * 60_000;
        const start = new Date(startsAt);
        return { input: { title: weeklyReview.title, objective: weeklyReview.goal, description: weeklyReview.workingPrompt, template: "working-session", leadSlug: "editor", participantSlugs: ["editor", "scout"], startsAt, schedule: { kind: "weekly", timezone: "UTC", daysOfWeek: [start.getUTCDay()], hour: start.getUTCHours(), minute: start.getUTCMinutes() }, repeatUntil: startsAt + 14 * 86_400_000, durationMinutes: 5, maxReplies: 3, state: "active", artifacts: [] } };
      } },
      { id: "weekly-created-details", name: "coworker_event_details", args: () => ({ id: eventFrom("weekly-create").id }) },
    ],
    pause: [
      { id: "weekly-pause-details", name: "coworker_event_details", args: () => ({ id: eventFrom("weekly-create").id }) },
      { id: "weekly-pause", name: "coworker_event_manage", args: () => ({ id: eventFrom("weekly-create").id, action: "pause", expectedRevision: eventFrom("weekly-pause-details").revision }) },
    ],
    update: [
      { id: "weekly-update-details", name: "coworker_event_details", args: () => ({ id: eventFrom("weekly-create").id }) },
      { id: "weekly-update", name: "coworker_event_update", args: () => {
        const event = eventFrom("weekly-update-details");
        const input = Object.fromEntries(["title", "description", "objective", "template", "leadSlug", "participantSlugs", "startsAt", "schedule", "repeatUntil", "durationMinutes", "maxReplies", "state", "artifacts"].map((key) => [key, event[key]]));
        return { id: event.id, expectedRevision: event.revision, input: { ...input, objective: weeklyReview.revisedGoal } };
      } },
      { id: "weekly-resume", name: "coworker_event_manage", args: () => ({ id: eventFrom("weekly-update").id, action: "resume", expectedRevision: eventFrom("weekly-update").revision }) },
    ],
    run: [{ id: "weekly-run-now", name: "coworker_event_manage", args: () => ({ id: eventFrom("weekly-create").id, action: "run_now" }) }],
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url?.endsWith("/models")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ object: "list", data: ["team", "conversation"].map((id) => ({ id, object: "model" })) })); return;
      }
      if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) { response.writeHead(404); response.end(); return; }
      let raw = "";
      for await (const chunk of request) raw += chunk;
      prompts.push(raw);
      const body: unknown = JSON.parse(raw);
      if (!record(body) || !Array.isArray(body.messages)) throw new Error("Model witness needs messages");
      if (typeof body.model !== "string" || !["team", "conversation"].includes(body.model)) throw new Error("Unexpected model at the local Event witness");
      const messages = body.messages.filter(record);
      const lastUser = messages.findLastIndex((message) => message.role === "user");
      const prompt = messageText(messages[lastUser]?.content);
      const outputs = messages.slice(lastUser + 1).filter((message) => message.role === "tool");
      for (const output of outputs) {
        const call = calls.find((item) => item.id === output.tool_call_id);
        if (!call) throw new Error("Unexpected native tool receipt");
        if (!receipts.some((item) => item.id === call.id)) receipts.push({ ...call, output: messageText(output.content) });
      }
      const tools = Array.isArray(body.tools) ? body.tools.filter(record) : [];
      const action = !prompt.includes("Phase:") && Object.entries(weeklyPrompts).find(([, words]) => prompt.includes(words))?.[0];
      if (tools.length && action === "create") weekly = true;
      const phase = tools.length ? prompt.match(/Phase: (contributions|conclusion)\./)?.[1] ?? "" : "";
      const continuity: unknown = JSON.parse(prompt.match(/^Continuity: (.+)$/m)?.[1] ?? "null");
      const sourceRunId = record(continuity) && typeof continuity.sourceRunId === "string" ? continuity.sourceRunId : "";
      const conclusionId = weekly ? `weekly-conclusion-${sourceRunId || "first"}` : "event-conclusion";
      const conclusion = phase === "conclusion";
      const outcome = weekly ? weeklyOutcomes[sourceRunId ? 1 : 0]! : eventOutcome;
      const routing = prompt.includes("You are the facilitator of the group chat") || prompt.includes("Your last answer was not accepted");
      requests.push({ model: body.model, speaker: prompt.match(/You are (Editor|Scout), Launch reviewer, in the group chat/)?.[1] ?? "", phase, facilitator: routing, prompt });
      let call: Omit<ToolReceipt, "output"> | undefined;
      let reply = "";
      if (tools.length && action && (action === "create" || action === "pause" || action === "update" || action === "run")) {
        const next = plans[action][outputs.length];
        if (next) call = { id: next.id, name: next.name, args: next.args() };
        else reply = weeklyReplies[action];
      } else if (conclusion && !outputs.some((message) => message.tool_call_id === conclusionId)) {
        call = { id: conclusionId, name: "coworker_event_conclude", args: { outcome } };
      }
      if (call && !tools.some((tool) => record(tool.function) && tool.function.name === call.name)) throw new Error(`Native engine did not advertise ${call.name}`);
      const text = routing
        ? JSON.stringify({ speakers: [{ slug: "scout", brief: "Check the current evidence." }, { slug: "editor", brief: "Summarize the evidence for the person." }], mode: "sequential", dependsOn: [["editor", "scout"]], followUp: null, synthesizer: null })
        : "The team is ready to review the launch. I recommend checking the remaining customer blockers first; I have not taken any external action.";
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const packet = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: "all-hands-reply", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      if (call) {
        if (calls.some((previous) => previous.id === call.id)) throw new Error(`Duplicate native tool request: ${call.id}`);
        calls.push(call);
        response.write(packet({ role: "assistant", tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }));
        response.write(packet({}, "tool_calls"));
      } else {
        response.write(packet({ role: "assistant", content: reply || (conclusion ? outcome.summary : text) }));
        response.write(packet({}, "stop"));
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Model witness did not bind");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, prompts, requests, calls, receipts, errors, result, async [Symbol.asyncDispose]() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}
