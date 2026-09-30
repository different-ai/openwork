import { createServer } from "node:http";

// A model-only witness. OAuth and capability results still come from the real
// gateway and the existing connector mock; this server never answers for them.
let workloads = [];
const requests = [];
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" ? value
  : Array.isArray(value) ? value.map(text).join("\n")
  : record(value) ? text(value.content ?? value.text) : "";
const json = (response, status, body) => response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" }).end(JSON.stringify(body));

function payload(value) {
  if (typeof value === "string") {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("No JSON tool result reached the model");
    return payload(JSON.parse(value.slice(start, end + 1)));
  }
  if (!record(value)) throw new Error("Expected a tool result object");
  if (Array.isArray(value.matches) || typeof value.connectionId === "string") return value;
  for (const key of ["structuredContent", "result", "output"]) {
    if (value[key] !== undefined) return payload(value[key]);
  }
  if (Array.isArray(value.content)) return payload(text(value.content));
  throw new Error("No connection or capability result reached the model");
}

function decide(body) {
  const messages = Array.isArray(body.messages) ? body.messages.filter(record) : [];
  const latestUser = messages.findLastIndex(message => message.role === "user"
    && !/^<system-update>\n[\s\S]*\n<\/system-update>$/.test(text(message.content)));
  const prompt = text(messages[latestUser]?.content);
  const matched = workloads.filter(workload => prompt.includes(workload.promptMarker));
  const results = messages.slice(latestUser + 1).filter(message => message.role === "tool");
  const advertisedToolNames = (body.tools ?? []).flatMap(tool => typeof tool.function?.name === "string" ? [tool.function.name] : []);
  const request = {
    model: typeof body.model === "string" ? body.model : "connection-action-model",
    promptMarker: matched[0]?.promptMarker ?? null,
    matchedMarkers: matched.map(workload => workload.promptMarker),
    completedTools: results.length, advertisedToolNames,
    kind: "utility", toolName: null, arguments: {}, at: new Date().toISOString(),
  };
  // Record on receipt, not on response completion: a model request made while
  // the card is pending is visible even if its response has not finished.
  requests.push(request);
  if (!advertisedToolNames.length) return { request, reply: "Connection setup" };
  if (matched.length !== 1) throw new Error(`Expected one workload, found ${matched.length}`);
  const workload = matched[0];
  const step = workload.steps[results.length];
  if (!step) {
    request.kind = "final";
    if (workload.finalReplyFrom !== "connection-decision") return { request, reply: workload.finalReply };
    const observed = payload(text(results.at(-1)?.content));
    const outcome = observed.connectionDecision?.outcome;
    // Retain the observed result in the ledger, but don't show protocol JSON
    // in the person's answer. No fixture choice dictates this outcome.
    request.toolResultCodes = { connectionResult: observed };
    if (outcome !== "connected" && outcome !== "skipped") throw new Error("The model received no settled connection decision");
    return { request, reply: outcome === "connected"
      ? "Notion is connected. The dashboard outline is ready."
      : "Notion setup was skipped. The dashboard outline is ready." };
  }
  const toolName = advertisedToolNames.find(name => name === step.tool || name.endsWith(`_${step.tool}`));
  if (!toolName) throw new Error(`Tool ${step.tool} was not advertised`);
  let args = step.arguments;
  if (step.argumentsFrom === "capability-search") {
    const found = payload(text(results.at(-1)?.content));
    if (found.matches?.length !== 1 || typeof found.matches[0].name !== "string") throw new Error("Search did not return one exact capability");
    args = { code: `return await tools["openwork-cloud"].execute_capability(${JSON.stringify({ name: found.matches[0].name })});` };
  } else if (step.argumentsFrom) throw new Error(`Unsupported connection witness handoff ${step.argumentsFrom}`);
  Object.assign(request, { kind: "tool", toolName, arguments: args });
  return { request, before: step.textBeforeTool };
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") return json(response, 200, { ok: true });
    if (request.method === "GET" && request.url === "/requests") return json(response, 200, { requests: requests.map(agentCompletion => ({
      method: "POST", path: "/v1/chat/completions", url: "/v1/chat/completions", at: agentCompletion.at, agentCompletion,
    })) });
    if (request.method !== "POST") return json(response, 404, { error: "not_found" });
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw);
    if (request.url === "/admin/agent-workloads") {
      if (!Array.isArray(body.workloads) || body.workloads.some(workload => !record(workload)
        || typeof workload.promptMarker !== "string" || !Array.isArray(workload.steps)
        || workload.steps.some(step => !record(step) || typeof step.tool !== "string" || !record(step.arguments)
          || (step.textBeforeTool !== undefined && typeof step.textBeforeTool !== "string")))) {
        return json(response, 400, { error: "invalid_workloads" });
      }
      workloads = body.workloads;
      return json(response, 200, { configured: workloads.length });
    }
    if (request.url !== "/v1/chat/completions") return json(response, 404, { error: "not_found" });
    const result = decide(body);
    const { request: completion } = result;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
      id: `chatcmpl-connection-${requests.length}`, object: "chat.completion.chunk", created: 1,
      model: completion.model, choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    send({ role: "assistant" });
    if (result.before) send({ content: result.before });
    const tool = completion.kind === "tool";
    send(tool ? { tool_calls: [{ index: 0, id: `call_connection_${requests.length}`, type: "function",
      function: { name: completion.toolName, arguments: JSON.stringify(completion.arguments) } }] } : { content: result.reply });
    send({}, tool ? "tool_calls" : "stop");
    response.end("data: [DONE]\n\n");
  } catch (error) {
    const latest = requests.at(-1);
    if (latest) latest.kind = "error";
    json(response, 500, { error: { message: String(error) } });
  }
});
server.listen(Number(process.env.PORT ?? 3979), process.env.HOST ?? "127.0.0.1");
