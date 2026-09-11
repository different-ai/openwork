import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import type { MockAgentRequest } from "./mock-mcp.ts";

export const skillJitModelScript = fileURLToPath(import.meta.url);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("\n");
  if (!record(value)) return "";
  return text(value.content ?? value.text);
}

function systemUpdate(message: Record<string, unknown>): string | null {
  const update = message.role === "user" ? text(message.content).match(/^<system-update>\n([\s\S]*)\n<\/system-update>$/) : null;
  return update ? update[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null;
}

function catalog(messages: Record<string, unknown>[]) {
  const system = messages.flatMap((message) => {
    if (message.role === "system" || message.role === "developer") return [text(message.content)];
    const update = systemUpdate(message);
    return update === null ? [] : [update];
  }).join("\n");
  if (!system.includes("You are OpenWork.")) throw new Error("The model did not receive OpenWork operating instructions");
  const skills = new Map<string, { id: string; name: string; description: string }>();
  for (const update of system.split(/(?=<available_skills>|The available skills have changed|New skills are available|The following skill IDs|Skill guidance is no longer available|No skills are currently available)/)) {
    if (update.startsWith("<available_skills>") || update.startsWith("The available skills have changed")
      || update.startsWith("Skill guidance is no longer available") || update.startsWith("No skills are currently available")) skills.clear();
    for (const [, entry] of update.matchAll(/<skill>([\s\S]*?)<\/skill>/g)) {
      const id = entry.match(/<id>([^<]+)<\/id>/)?.[1];
      const name = entry.match(/<name>([^<]+)<\/name>/)?.[1];
      const description = entry.match(/<description>([^<]+)<\/description>/)?.[1];
      if (id && name && description) skills.set(id, { id, name, description });
    }
    const removed = update.match(/The following skill IDs are no longer available and must not be used: ([^\n]+)\./)?.[1];
    for (const id of removed?.split(", ") ?? []) skills.delete(id);
  }
  return [...skills.values()];
}

function matchesPrompt(description: string, prompt: string): boolean {
  const words = (value: string) => value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const request = ` ${words(prompt).join(" ")} `;
  const terms = words(description);
  return terms.some((_, index) => index + 3 <= terms.length && request.includes(` ${terms.slice(index, index + 3).join(" ")} `));
}

function decide(body: Record<string, unknown>, turn: { prompt: string; forcedSkillId?: string } | null, credential: "unknown" | "missing") {
  const messages = Array.isArray(body.messages) ? body.messages.filter(record) : [];
  const latestUserIndex = messages.findLastIndex((message) => message.role === "user" && systemUpdate(message) === null);
  const prompt = text(messages[latestUserIndex]?.content);
  const matched = turn !== null && prompt.includes(turn.prompt);
  const results = messages.slice(latestUserIndex + 1).filter((message) => message.role === "tool");
  const request: MockAgentRequest = {
    model: typeof body.model === "string" ? body.model : "skill-jit-model",
    credential,
    promptMarker: matched ? turn.prompt : null,
    matchedMarkers: matched ? [turn.prompt] : [],
    completedTools: results.length,
    kind: matched ? "final" : "utility",
    toolName: null,
    arguments: {},
    at: new Date().toISOString(),
  };
  if (!matched) return { request, reply: "Active session workload" };
  if (results.length) {
    const reply = text(results.at(-1)?.content);
    if (!reply) throw new Error("The model received no tool result text");
    return { request, reply };
  }
  const skills = catalog(messages);
  const tools = Array.isArray(body.tools) ? body.tools.filter(record) : [];
  const tool = tools.find((item) => item.type === "function" && record(item.function) && item.function.name === "skill");
  const parameters = tool && record(tool.function) && record(tool.function.parameters) ? tool.function.parameters : null;
  const idSchema = parameters && record(parameters.properties) && record(parameters.properties.id) ? parameters.properties.id : null;
  if (parameters?.type === "object" && idSchema?.type === "string"
    && (!Array.isArray(parameters.required) || parameters.required.every((key) => key === "id"))) {
    const matches = skills.filter((skill) => matchesPrompt(skill.description, prompt)
      && (!Array.isArray(idSchema.enum) || idSchema.enum.includes(skill.id)));
    const id = turn.forcedSkillId ?? (matches.length === 1 ? matches[0].id : null);
    if (id) {
      request.kind = "tool";
      request.toolName = "skill";
      request.arguments = { id };
    }
  }
  return { request, reply: "OpenWork: UNAVAILABLE" };
}

if (import.meta.main) {
  let turn: { prompt: string; forcedSkillId?: string } | null = null;
  const requests: MockAgentRequest[] = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, host: "127.0.0.1" }));
        return;
      }
      if (req.method === "GET" && req.url === "/requests") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          requests: requests.map((request) => ({ method: "POST", path: "/v1/chat/completions", url: "/v1/chat/completions", at: request.at, agentCompletion: request })),
        }));
        return;
      }
      if (req.method !== "POST" || !["/admin/skill-turn", "/v1/chat/completions"].includes(req.url ?? "")) {
        res.writeHead(404).end();
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body: unknown = JSON.parse(raw);
      if (!record(body)) throw new Error("Model input must be an object");
      if (req.url === "/admin/skill-turn") {
        if (typeof body.prompt !== "string" || !body.prompt.trim()
          || (body.forcedSkillId !== undefined && (typeof body.forcedSkillId !== "string" || !body.forcedSkillId))) {
          throw new Error("Invalid skill turn");
        }
        turn = { prompt: body.prompt, ...(typeof body.forcedSkillId === "string" ? { forcedSkillId: body.forcedSkillId } : {}) };
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      const { request, reply } = decide(body, turn, req.headers.authorization?.trim() ? "unknown" : "missing");
      requests.push(request);
      const call = request.kind === "tool";
      const delta = call ? { tool_calls: [{ index: 0, id: `call_skill_${requests.length}`, type: "function",
        function: { name: request.toolName, arguments: JSON.stringify(request.arguments) } }] } : { content: reply };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [content, finish] of [[{ role: "assistant" }, null], [delta, null], [{}, call ? "tool_calls" : "stop"]]) {
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-skill-jit", object: "chat.completion.chunk", model: request.model,
          choices: [{ index: 0, delta: content, finish_reason: finish }] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    } catch (error) {
      console.error("[skill-jit-model] request failed", error);
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "Skill witness failed" }));
    }
  });
  server.listen(Number(process.env.PORT ?? 3979), "127.0.0.1");
}
