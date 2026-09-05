import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface ScriptedChunk {
  delta: Record<string, unknown>;
  finishReason?: string | null;
}

export interface ScriptedModelOptions {
  providerId: string;
  modelId: string;
  script: (request: Record<string, unknown>) => readonly ScriptedChunk[] | Promise<readonly ScriptedChunk[]>;
}

export interface ModelWitness {
  providerId: string;
  modelId: string;
  baseUrl: string;
  close: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

function streamChunk(modelId: string, chunk: ScriptedChunk): Record<string, unknown> {
  return {
    id: "chatcmpl-docs-shots",
    object: "chat.completion.chunk",
    created: 1,
    model: modelId,
    choices: [{ index: 0, delta: chunk.delta, finish_reason: chunk.finishReason ?? null }],
  };
}

function sendStream(response: ServerResponse, modelId: string, chunks: readonly ScriptedChunk[]): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
  let delayMs = 250;
  for (const chunk of chunks) {
    setTimeout(() => response.write(`data: ${JSON.stringify(streamChunk(modelId, chunk))}\n\n`), delayMs);
    delayMs += 250;
  }
  setTimeout(() => response.end("data: [DONE]\n\n"), delayMs);
}

/** Start a generic OpenAI-compatible model whose replies come from a script. */
export async function startModelWitness(options: ScriptedModelOptions): Promise<ModelWitness> {
  const fixture = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        sendJson(response, 200, { object: "list", data: [{ id: options.modelId, object: "model" }] });
        return;
      }
      if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
        const parsed: unknown = JSON.parse(await readBody(request));
        if (!isRecord(parsed)) throw new Error("The model witness received a non-object request.");
        sendStream(response, options.modelId, await options.script(parsed));
        return;
      }
      sendJson(response, 404, { error: { message: "not found" } });
    })().catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
  await new Promise<void>((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", resolve);
  });
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("The model witness did not bind a port.");
  return {
    providerId: options.providerId,
    modelId: options.modelId,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => fixture.close((error) => (error ? reject(error) : resolve()))),
  };
}
