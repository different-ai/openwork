import { createServer } from "node:http";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read only the engine's real tool results, including MCP text envelopes. */
export function slackResultObjects(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 14) return [];
  if (typeof value === "string") {
    try { return slackResultObjects(JSON.parse(value), depth + 1); } catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap(entry => slackResultObjects(entry, depth + 1));
  if (!record(value)) return [];
  return [value, ...Object.values(value).flatMap(entry => slackResultObjects(entry, depth + 1))];
}

export function slackSearchHits(value: unknown) {
  return slackResultObjects(value).flatMap(entry => {
    const text = typeof entry.content === "string" ? entry.content : entry.text;
    const channelId = entry.channelId ?? entry.channel_id;
    const ts = entry.ts ?? entry.message_ts ?? entry.messageTs;
    const link = entry.permalink ?? entry.sourceUrl ?? entry.url;
    return typeof text === "string" && typeof channelId === "string" && typeof ts === "string" && typeof link === "string"
      ? [{ text, channelId, ts, link }] : [];
  });
}

export function slackIncomplete(value: unknown): boolean {
  return slackResultObjects(value).some(entry => entry.incomplete === true || entry.partial === true || entry.hasMore === true
    || entry.has_more === true || entry.complete === false || entry.contextComplete === false || entry.isComplete === false);
}
export function slackLimited(value: unknown): boolean {
  return slackResultObjects(value).some(entry => entry.limitedAccess === true || entry.limited === true
    || [entry.omittedConversationTypes, entry.unavailableConversationTypes, entry.unavailableTypes, entry.unsearchedConversationTypes].some(types => Array.isArray(types) && types.length > 0));
}

function capability(value: unknown, operation: "search" | "threads") {
  const found = slackResultObjects(value).find(entry => typeof entry.name === "string"
    && entry.name.startsWith("native:") && /slack/i.test(entry.name) && entry.name.toLowerCase().endsWith(operation));
  if (!found || typeof found.name !== "string") throw new Error(`Real discovery omitted native Slack ${operation}`);
  return found;
}

function execution(found: Record<string, unknown>, input: Record<string, unknown>) {
  return { name: found.name, ...input, ...(typeof found.schemaDigest === "string" ? { schemaDigest: found.schemaDigest } : {}) };
}

// This is model-side Code Mode, not a nested test runner. Every provider action
// still traverses the real engine -> Cloud MCP -> native Den HTTP adapter.
const codeMode = `
const objects = (value, depth = 0) => {
  if (depth > 14) return [];
  if (typeof value === "string") { try { return objects(JSON.parse(value), depth + 1); } catch { return []; } }
  if (Array.isArray(value)) return value.flatMap(item => objects(item, depth + 1));
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(item => objects(item, depth + 1))];
};
const catalog = await tools["openwork-cloud"].search_capabilities({ query: "slack", type: "api", limit: 20 });
const find = operation => {
  const match = objects(catalog).find(entry => typeof entry.name === "string" && entry.name.startsWith("native:") && /slack/i.test(entry.name) && entry.name.toLowerCase().endsWith(operation));
  if (!match) throw new Error("Real discovery omitted native Slack " + operation);
  return match;
};
const invoke = (match, input) => tools["openwork-cloud"].execute_capability({ name: match.name, ...input, ...(match.schemaDigest ? { schemaDigest: match.schemaDigest } : {}) });
const search = await invoke(find("search"), { query: { query: "Amber launch", limit: 4 } });
const hit = objects(search).find(entry => typeof (entry.channelId ?? entry.channel_id) === "string" && typeof (entry.ts ?? entry.message_ts ?? entry.messageTs) === "string");
if (!hit) throw new Error("Real native search returned no usable thread identity");
const thread = await invoke(find("threads"), { query: { channelId: hit.channelId ?? hit.channel_id, ts: hit.ts ?? hit.message_ts ?? hit.messageTs, limit: 2 } });
return { search, thread };
`;

/** Synthetic inference, never seeded answer prose or Slack resource identifiers. */
export async function startNativeSlackModel(prompts: readonly string[]) {
  const inputs: Array<{ prompt: string; userText: string }> = [];
  const calls: Array<{ prompt: string; tool: string; args: Record<string, unknown> }> = [];
  const outputs: Array<{ prompt: string; text: string; result: unknown }> = [];
  const failures: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return;
      }
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const input: unknown = JSON.parse(raw);
      if (!record(input)) throw new Error("Expected a model request");
      const messages = Array.isArray(input.messages) ? input.messages.filter(record) : [];
      const lastUser = messages.findLastIndex(message => message.role === "user");
      const userText = JSON.stringify(messages[lastUser]?.content ?? "");
      const prompt = prompts.find(candidate => userText.includes(candidate));
      const tools = Array.isArray(input.tools) ? input.tools.filter(record) : [];
      const names = tools.flatMap(tool => record(tool.function) && typeof tool.function.name === "string" ? [tool.function.name] : []);
      const results = messages.slice(lastUser + 1).filter(message => message.role === "tool");
      let call: { tool: string; args: Record<string, unknown> } | undefined;
      let text = "Synthetic conversation";
      if (prompt && names.length > 0) {
        inputs.push({ prompt, userText });
        const searchTool = names.find(name => name.endsWith("search_capabilities"));
        const executeTool = names.find(name => name.endsWith("execute_capability"));
        if (!searchTool || !executeTool) {
          if (!names.includes("execute")) throw new Error("The engine advertised neither native Cloud tools nor Code Mode");
          if (results.length === 0) call = { tool: "execute", args: { code: codeMode } };
        } else if (results.length === 0) {
          call = { tool: searchTool, args: { query: "slack", type: "api", limit: 20 } };
        } else if (results.length === 1) {
          call = { tool: executeTool, args: execution(capability(results[0].content, "search"), { query: { query: "Amber launch", limit: 4 } }) };
        } else if (results.length === 2) {
          const hit = slackSearchHits(results[1].content)[0];
          if (!hit) throw new Error("Native Slack search returned no source-linked thread identity");
          call = { tool: executeTool, args: execution(capability(results[0].content, "threads"), { query: { channelId: hit.channelId, ts: hit.ts, limit: 2 } }) };
        }
        if (!call) {
          const hits = slackSearchHits(results);
          if (hits.length === 0) throw new Error("Refusing to fabricate a Slack answer without observed results");
          const unique = [...new Map(hits.map(hit => [hit.link, hit])).values()];
          text = unique.map(hit => `${hit.text} [Slack source](${hit.link})`).join("\n\n");
          if (slackIncomplete(results)) text += "\n\nIncomplete thread context: this is a bounded excerpt, not the complete thread.";
          if (slackLimited(results)) text += "\n\nLimited access: private channels and direct messages were not searched, not reported as empty.";
          outputs.push({ prompt, text, result: results.map(result => result.content) });
        }
      }
      if (call && prompt) calls.push({ prompt, ...call });
      const delta = call
        ? { tool_calls: [{ index: 0, id: `call_slack_${results.length}`, type: "function", function: { name: call.tool, arguments: JSON.stringify(call.args) } }] }
        : { content: text };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of [
        { id: "slack-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
        { id: "slack-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] },
      ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end("data: [DONE]\n\n");
    })().catch(error => {
      failures.push(error instanceof Error ? error.message : String(error));
      response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Synthetic Slack model refused an unproven answer" }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic Slack model did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/v1`, inputs: () => structuredClone(inputs), calls: () => structuredClone(calls),
    outputs: () => structuredClone(outputs), failures: () => failures.slice(),
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    },
  };
}
