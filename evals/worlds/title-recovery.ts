import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { SkipError, type Seed } from "@openwork/env";
import { bootManagedOpenworkServer, close, engineBinary, isRecord, listen, readBody, sendJson, sendStream } from "./openwork-server-cli.ts";

export const GENERATED_TITLE = "Kites in a sunny meadow";
export const REPLY = "A kite catches the breeze.";
export const PRIVATE_ERROR_MARKER = "private-provider-body-must-not-be-in-title-diagnostics";
export type WitnessRequest = { provider: string; url: string; model: string; title: boolean; effort: unknown; temperature: unknown; topP: unknown; marker: boolean; auth: string; body: string };

export async function titleRecovery(seed: Seed) {
  const binary = engineBinary();
  if (!binary) throw new SkipError("set OPENWORK_OPENCODE_BIN or install opencode");
  const root = seed.tmpPath("title-recovery");
  await mkdir(root, { recursive: true });
  const scratch = await realpath(root);
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  const requests: WitnessRequest[] = [];
  const witness = (provider: "responses" | "compatible") => createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") return sendJson(response, 200, { data: [] });
      const raw = await readBody(request);
      const body: unknown = JSON.parse(raw);
      if (!isRecord(body) || typeof body.model !== "string") return sendJson(response, 400, {});
      const title = raw.includes("Generate a title for this conversation");
      const responses = provider === "responses";
      const effort = isRecord(body.reasoning) ? body.reasoning.effort : body.reasoning_effort;
      requests.push({ provider, url: `http://${request.headers.host}${request.url}`, model: body.model, title, effort, temperature: body.temperature, topP: body.top_p,
        marker: Boolean(request.headers["x-openwork-title-attempt"]), auth: String(request.headers.authorization), body: raw });
      // Each provider accepts only its own model, protocol endpoint, and credential.
      if (responses !== ["gpt-6-astra", "gpt-6-default-effort"].includes(body.model) || request.url !== (responses ? "/v1/responses" : "/v1/chat/completions")) return sendJson(response, 404, {});
      if (request.headers.authorization !== `Bearer title-witness-${provider}`) return sendJson(response, 401, {});
      // No recognized effort list: only omission of the rejected field succeeds.
      // Include the provider URL to make diagnostic redaction observable too.
      if (effort !== undefined && ((title && ["default-effort", "gpt-6-default-effort"].includes(body.model))
        || (!title && body.model === "main-rejected"))) return sendJson(response, 400, { error: {
        code: "unsupported_value", param: responses ? "reasoning.effort" : "reasoning_effort",
        message: `Unsupported reasoning effort. ${PRIVATE_ERROR_MARKER} http://${request.headers.host}${request.url}`,
      } });
      if (title) {
        if (body.model === "denied") return sendJson(response, 403, { error: { message: PRIVATE_ERROR_MARKER } });
        if (body.model === "limited") return sendJson(response, 429, { error: { message: PRIVATE_ERROR_MARKER } });
        if (body.model === "malformed") return sendJson(response, 400, { error: { code: "unsupported_value", param: "model", message: PRIVATE_ERROR_MARKER } });
        if (body.model === "twice" || effort === "none" || (body.model === "other-reasoner" && effort === "low")) return sendJson(response, 400, { error: {
          code: "unsupported_value", param: responses ? "reasoning.effort" : "reasoning_effort",
          message: `Unsupported value. Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'. ${PRIVATE_ERROR_MARKER}`,
        } });
        if (body.model === "sampling" && body.temperature !== undefined) return sendJson(response, 400, { error: {
          code: "unsupported_parameter", param: "temperature", message: PRIVATE_ERROR_MARKER,
        } });
        if (body.model === "nucleus-sampling" && body.top_p !== undefined) return sendJson(response, 400, { error: {
          code: "unsupported_parameter", param: "top_p", message: PRIVATE_ERROR_MARKER,
        } });
      }
      const text = title ? (body.model === "empty" ? "" : GENERATED_TITLE) : REPLY;
      const id = `resp_title_${requests.length}`;
      if (responses) {
        const item = { id: `${id}_message`, type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text, annotations: [] }] };
        sendStream(response, [
          { type: "response.created", response: { id, created_at: 1, model: body.model, status: "in_progress", output: [] }, sequence_number: 0 },
          { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] }, sequence_number: 1 },
          { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text, sequence_number: 2 },
          { type: "response.output_item.done", output_index: 0, item, sequence_number: 3 },
          { type: "response.completed", response: { id, created_at: 1, model: body.model, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }, sequence_number: 4 },
        ]);
      } else sendStream(response, [
        { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
        { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    })().catch(() => { if (!response.headersSent) sendJson(response, 500, {}); else response.end(); });
  });
  const responsesProvider = witness("responses");
  const compatibleProvider = witness("compatible");
  const responsesURL = await listen(responsesProvider);
  const compatibleURL = await listen(compatibleProvider);
  const endpoints = { responses: responsesURL + "/v1/responses", compatible: compatibleURL + "/v1/chat/completions" };
  const model = { reasoning: true, temperature: true, tool_call: true,
    release_date: "2026-09-04", limit: { context: 128_000, output: 4096 },
    variants: { none: { reasoningEffort: "none" }, xhigh: { reasoningEffort: "xhigh" } } };
  await writeFile(join(workspace, "opencode.json"), JSON.stringify({
    agent: { title: { top_p: 0.8 } },
    provider: {
      responses: { npm: "@ai-sdk/openai", options: { baseURL: responsesURL + "/v1", apiKey: "title-witness-responses" }, models: { "gpt-6-astra": model, "gpt-6-default-effort": model } },
      compatible: { npm: "@ai-sdk/openai-compatible", options: { baseURL: compatibleURL + "/v1", apiKey: "title-witness-compatible" },
        models: Object.fromEntries(["other-reasoner", "default-effort", "main-rejected", "sampling", "nucleus-sampling", "denied", "limited", "malformed", "twice", "empty"].map((id) => [id,
          ["sampling", "nucleus-sampling", "empty"].includes(id) ? { ...model, reasoning: false, variants: {} } : model])) },
    },
  }));
  const token = "title-recovery-test-client";
  const updates: { id: string; title: string }[] = [];
  const abort = new AbortController();
  let managed: Awaited<ReturnType<typeof bootManagedOpenworkServer>> | undefined;
  let events: Promise<void> | undefined;
  const dispose = async () => {
    abort.abort();
    await events?.catch(() => undefined);
    await managed?.stop();
    await Promise.all([close(responsesProvider), close(compatibleProvider)]);
    await rm(scratch, { recursive: true, force: true });
  };
  try {
    managed = await bootManagedOpenworkServer({ scratch, workspace, token, binary, sink: () => undefined });
    const stream = await fetch(`${managed.base}/workspace/${managed.workspaceId}/opencode/event`, {
      headers: { authorization: `Bearer ${token}` }, signal: abort.signal,
    });
    const reader = stream.body?.getReader();
    if (!stream.ok || !reader) throw new Error("Session event stream unavailable");
    events = (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.startsWith("data: ")) continue;
          const event: unknown = JSON.parse(line.slice(6));
          if (!isRecord(event) || event.type !== "session.updated" || !isRecord(event.properties)) continue;
          const info = event.properties.info;
          if (isRecord(info) && typeof info.id === "string" && typeof info.title === "string") updates.push({ id: info.id, title: info.title });
        }
      }
    })();
    void events.catch(() => undefined);
    return {
      engine: managed.engine, requests, updates, endpoints,
      diagnostics: async () => (await readFile(join(scratch, "home/.local/share/opencode/log/opencode.log"), "utf8"))
        .split("\n").filter((line) => line.includes("Automatic title generation")),
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) { await dispose(); throw error; }
}
