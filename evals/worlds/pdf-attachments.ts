import { spawnSync } from "node:child_process";
import { mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { SkipError } from "@openwork/env";
import type { Seed } from "@openwork/env";
import { buildTestPdf, pdfDataUrl } from "../../apps/server/src/pdf-attachments/pdf-fixture.test-helper.ts";
import { bootManagedOpenworkServer, close, engineBinary, isRecord, listen, readBody, sendJson, sendStream } from "./openwork-server-cli.ts";

// A PDF attached in chat must work with every model the engine can run. The
// engine forwards a PDF part to the provider untouched, so a model without PDF
// input fails the whole request. OpenWork's openwork-pdf-attachments engine
// plugin rewrites only the provider-facing copy per step: native PDF stays
// native, image-capable models get rendered pages plus text, text-only models
// get text, and the transcript keeps the original PDF part.
//
// This world boots the real openwork-server CLI, which writes the engine's
// runtime config (including the shipped plugin list) and spawns the real
// OpenCode engine against a workspace whose only provider is a loopback mock
// that records exactly what each model received.

export const READ_SCENARIO_MARKER = "Read the PDF on disk and summarize it.";
export const MOCK_REPLY = "MOCK OK";
export const ON_DISK_PDF = "on-disk.pdf";
export const ATTACHED_PDF = "report.pdf";

export type ProviderRequest = { model: string; parts: string[]; toolResults: string[]; tools: string[] };
export type PdfRoutingModel = "vision" | "text" | "native";

function summarizeToolResults(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.messages)) return [];
  const results: string[] = [];
  for (const message of body.messages) {
    if (!isRecord(message) || message.role !== "tool") continue;
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    results.push(content.includes("OpenWork prepared the PDF") ? "tool:note" : `tool:${content.slice(0, 30)}`);
  }
  return results;
}

function toolNames(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.tools)) return [];
  return body.tools.map((tool) => (isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === "string" ? tool.function.name : "?"));
}

function lastUserText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.messages)) return "";
  const users = body.messages.filter((message) => isRecord(message) && message.role === "user");
  const last = users.at(-1);
  if (!isRecord(last)) return "";
  const content = Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }];
  return content.filter(isRecord).filter((item) => item.type === "text").map((item) => String(item.text)).join("\n");
}

function summarizeUserContent(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.messages)) return [];
  const parts: string[] = [];
  for (const message of body.messages) {
    if (!isRecord(message) || message.role !== "user") continue;
    const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === "image_url" && isRecord(item.image_url) && typeof item.image_url.url === "string") {
        parts.push(`image_url:${item.image_url.url.split(";")[0]}`);
      } else if (item.type === "file") {
        parts.push(`file:${isRecord(item.file) && typeof item.file.filename === "string" ? item.file.filename : "?"}`);
      } else if (item.type === "text" && typeof item.text === "string") {
        parts.push(item.text.startsWith("OpenWork prepared the PDF") ? "text:note" : `text:${item.text.slice(0, 20)}`);
      } else {
        parts.push(`other:${String(item.type)}`);
      }
    }
  }
  return parts;
}

/**
 * A mock OpenAI-compatible provider. Every chat completion replies MOCK OK,
 * except the first turn of the read scenario, which asks the engine to run its
 * Read tool on the workspace PDF so the follow-up request shows what a
 * tool-result PDF becomes.
 */
function mockProvider(workspace: string, requests: ProviderRequest[]): Server {
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const body: unknown = JSON.parse(await readBody(request));
        requests.push({
          model: isRecord(body) && typeof body.model === "string" ? body.model : "?",
          parts: summarizeUserContent(body),
          toolResults: summarizeToolResults(body),
          tools: toolNames(body),
        });
        const askToRead = lastUserText(body).includes(READ_SCENARIO_MARKER) && summarizeToolResults(body).length === 0;
        const id = `chatcmpl-pdf-routing-${requests.length}`;
        sendStream(response, askToRead
          ? [
            { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
            { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_read_pdf", type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: join(workspace, ON_DISK_PDF) }) } }] }, finish_reason: null }] },
            { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          ]
          : [
            { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
            { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: MOCK_REPLY }, finish_reason: null }] },
            { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]);
        return;
      }
      sendJson(response, 200, { object: "list", data: [] });
    })().catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
}

export interface PdfRoutingWorld extends AsyncDisposable {
  /** openwork-server base URL. */
  base: string;
  workspaceId: string;
  workspacePath: string;
  engineVersion: string;
  /** The PDF the spec attaches: three pages, the last one without a text layer. */
  attachment: { type: "file"; mime: "application/pdf"; filename: string; url: string };
  /** Everything the mock provider received, in order. */
  requests: ProviderRequest[];
  /** Proxied engine call through openwork-server: path is relative to the engine root, e.g. /session. */
  engine(method: string, path: string, body?: unknown): Promise<unknown>;
  /** Derived PDF bundle directories the plugin left in the workspace inbox. */
  derivedBundles(): Promise<string[]>;
  /** openwork-server and engine output so far, for diagnostics. */
  output(): string;
}

export async function pdfRouting(seed: Seed): Promise<PdfRoutingWorld> {
  const binary = engineBinary();
  if (!binary) throw new SkipError("set OPENWORK_OPENCODE_BIN or install opencode");

  const root = seed.tmpPath("pdf-routing");
  await mkdir(root, { recursive: true });
  // Resolve symlinks (macOS /tmp -> /private/tmp) so the engine sees workspace files as inside the project.
  const scratch = await realpath(root);
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });

  const requests: ProviderRequest[] = [];
  const provider = mockProvider(workspace, requests);
  const providerUrl = await listen(provider);

  const model = (input: string[]) => ({
    name: input.join("+"),
    attachment: input.length > 1,
    tool_call: true,
    reasoning: false,
    temperature: true,
    modalities: { input, output: ["text"] },
    limit: { context: 128_000, output: 4_096 },
    cost: { input: 0, output: 0 },
  });
  await writeFile(join(workspace, ON_DISK_PDF), buildTestPdf(["Handbook chapter one", null]));
  await writeFile(join(workspace, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      mock: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock provider",
        options: { baseURL: `${providerUrl}/v1`, apiKey: "test" },
        models: { vision: model(["text", "image"]), text: model(["text"]), native: model(["text", "image", "pdf"]) },
      },
    },
  }, null, 2));

  const token = "pdf-routing-client-token";
  let output = "";
  const sink = (chunk: string) => { output += chunk; };
  let managed: Awaited<ReturnType<typeof bootManagedOpenworkServer>> | null = null;
  const dispose = async () => {
    if (managed) await managed.stop();
    await close(provider);
    // The engine installs its plugin runtime and packages cache into the scratch
    // HOME (hundreds of MB), so the world removes what it created.
    await rm(scratch, { recursive: true, force: true });
  };

  try {
    managed = await bootManagedOpenworkServer({ scratch, workspace, token, sink, binary });
    const engineVersion = spawnSync(managed.binary, ["--version"], { encoding: "utf8" }).stdout.trim();
    const attachment: PdfRoutingWorld["attachment"] = { type: "file", mime: "application/pdf", filename: ATTACHED_PDF, url: pdfDataUrl(buildTestPdf(["Quarterly revenue report", "Second page", null])) };

    return {
      base: managed.base,
      workspaceId: managed.workspaceId,
      workspacePath: workspace,
      engineVersion,
      attachment,
      requests,
      engine: managed.engine,
      async derivedBundles() {
        return (await readdir(join(workspace, ".opencode", "openwork", "inbox", "pdf-pages")).catch(() => [])).sort();
      },
      output: () => output,
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
