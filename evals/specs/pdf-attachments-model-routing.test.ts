import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { needs, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

import { OpenWorkPdfAttachments } from "../../apps/server/src/opencode-plugins/openwork-pdf-attachments";
import { resetDerivedPdfMemory } from "../../apps/server/src/pdf-attachments/derive";
import { buildTestPdf, pdfDataUrl } from "../../apps/server/src/pdf-attachments/pdf-fixture.test-helper";

// A PDF attached in chat must work with every model the engine can run. The
// engine forwards a PDF part to the provider untouched, so a model without
// PDF input fails the whole request. The openwork-pdf-attachments plugin
// rewrites only the provider-facing copy per step: native PDF stays native,
// image-capable models get rendered pages plus text, text-only models get
// text. The transcript keeps the original PDF part.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const serverRoot = join(repoRoot, "apps", "server");

const catalog = {
  data: {
    all: [
      { id: "anthropic", npm: "@ai-sdk/anthropic", models: { native: { id: "native", attachment: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] } } } },
      { id: "openrouter", npm: "@ai-sdk/openai-compatible", models: { vision: { id: "vision", attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } } },
      { id: "ollama", npm: "@ai-sdk/openai-compatible", models: { text: { id: "text", attachment: false, modalities: { input: ["text"], output: ["text"] } } } },
    ],
    default: {},
    connected: [],
  },
};

type Part = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function partsOf(message: unknown): Part[] {
  if (!isRecord(message) || !Array.isArray(message.parts)) throw new Error("Expected message parts");
  return message.parts.filter(isRecord);
}

function userMessage(providerID: string, modelID: string, pdf: string) {
  return {
    info: { id: "m1", sessionID: "ses", role: "user", model: { providerID, modelID } },
    parts: [
      { id: "p1", sessionID: "ses", messageID: "m1", type: "file", mime: "application/pdf", filename: "report.pdf", url: pdf },
      { id: "p2", sessionID: "ses", messageID: "m1", type: "text", text: "Summarize this." },
    ],
  };
}

test("PDF attachments are routed by what the current model can take as input", async ({ evidence }) => {
  const root = await mkdtemp(join(tmpdir(), "openwork-pdf-routing-"));
  try {
    resetDerivedPdfMemory();
    const pdf = pdfDataUrl(buildTestPdf(["Quarterly revenue report", null, "Appendix: totals"]));
    const plugin = await OpenWorkPdfAttachments({ directory: root, client: { provider: { list: async () => catalog } } });
    const hook = plugin["experimental.chat.messages.transform"];

    const native = { messages: [userMessage("anthropic", "native", pdf)] };
    await hook({}, native);
    expect(native.messages).toEqual([userMessage("anthropic", "native", pdf)]);
    evidence.recordAssertionEvidence(
      "A model that accepts PDF input receives the PDF part unchanged",
      "The native-PDF model's message was deep-equal to the original: one application/pdf file part and the user's text.",
      true,
    );

    const vision = { messages: [userMessage("openrouter", "vision", pdf)] };
    await hook({}, vision);
    const visionParts = partsOf(vision.messages[0]);
    const images = visionParts.filter((part) => part.type === "file");
    expect(images.map((part) => part.mime)).toEqual(["image/png", "image/png", "image/png"]);
    expect(images.map((part) => part.filename)).toEqual(["report - page 1.png", "report - page 2.png", "report - page 3.png"]);
    expect(images.every((part) => String(part.url).startsWith("data:image/png;base64,"))).toBe(true);
    const visionNote = visionParts.find((part) => part.type === "text" && String(part.text).startsWith("OpenWork prepared the PDF attachment"));
    expect(String(visionNote?.text)).toContain("text_layer: present on 2 of 3 extracted pages; pages without one: 2");
    expect(String(visionNote?.text)).toContain("--- page 1 ---\nQuarterly revenue report");
    expect(visionParts.at(-1)).toEqual({ id: "p2", sessionID: "ses", messageID: "m1", type: "text", text: "Summarize this." });
    evidence.recordAssertionEvidence(
      "An image-capable model without PDF input receives rendered page images in order plus page-marked text",
      "Three image/png data-URL parts named by page replaced the PDF, followed by a note carrying the extracted text and a flag for the image-only page; the user's own text part came last, unchanged.",
      true,
    );

    const textOnly = { messages: [userMessage("ollama", "text", pdf)] };
    await hook({}, textOnly);
    const textParts = partsOf(textOnly.messages[0]);
    expect(textParts.map((part) => part.type)).toEqual(["text", "text"]);
    expect(String(textParts[0].text)).toContain("This model cannot view images, so pages without a text layer are not readable here");
    expect(String(textParts[0].text)).toContain("--- page 3 ---\nAppendix: totals");
    evidence.recordAssertionEvidence(
      "A text-only model receives the extracted text and an honest note about pages it cannot read",
      "No file parts were sent; the note carried every page's text and said the image-only page is unreadable for this model.",
      true,
    );

    const derived = await readdir(join(root, ".opencode", "openwork", "inbox", "pdf-pages"));
    expect(derived).toHaveLength(1);
    const files = (await readdir(join(root, ".opencode", "openwork", "inbox", "pdf-pages", derived[0]))).sort();
    expect(files).toEqual(["manifest.json", "page-001.png", "page-002.png", "page-003.png", "text.md"]);
    evidence.recordAssertionEvidence(
      "Derived text and page images are kept in the workspace inbox for tools and later steps",
      `${derived[0]} holds ${files.join(", ")}.`,
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function engineBinary(): string | null {
  const fromEnv = process.env.OPENWORK_OPENCODE_BIN?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const platform = process.platform === "darwin" ? "apple-darwin" : process.platform === "win32" ? "pc-windows-msvc" : "unknown-linux-gnu";
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const sidecar = join(repoRoot, "apps", "desktop", "resources", "sidecars", `opencode-${arch}-${platform}${process.platform === "win32" ? ".exe" : ""}`);
  if (existsSync(sidecar)) return sidecar;
  const onPath = spawnSync(process.platform === "win32" ? "where" : "which", ["opencode"], { encoding: "utf8" });
  const found = onPath.status === 0 ? onPath.stdout.split(/\r?\n/).find((line) => line.trim()) : undefined;
  return found ? found.trim() : null;
}

const engineRequirements: TestNeeds = { commands: ["bun"] };
const engineMissing = [...unmetNeeds(engineRequirements, process.env), ...(engineBinary() ? [] : ["set OPENWORK_OPENCODE_BIN or install opencode"])];
const engineTitle = engineMissing.length > 0
  ? `the real engine sends each model what it can take skipped — needs: ${engineMissing.join(", ")}`
  : "the real engine sends each model what it can take from an attached PDF";

type ProviderRequest = { model: string; parts: string[] };

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
        parts.push(item.text.startsWith("OpenWork prepared the PDF attachment") ? "text:note" : `text:${item.text.slice(0, 20)}`);
      } else {
        parts.push(`other:${String(item.type)}`);
      }
    }
  }
  return parts;
}

test(engineTitle, async ({ evidence }) => {
  needs(engineRequirements);
  const binary = engineBinary();
  if (!binary) return;

  const scratch = await mkdtemp(join(tmpdir(), "openwork-pdf-engine-"));
  const pluginDir = join(scratch, "plugins");
  const home = join(scratch, "home");
  const workspace = join(scratch, "workspace");
  const requests: ProviderRequest[] = [];
  const mock = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body: unknown = JSON.parse(raw);
      requests.push({ model: isRecord(body) && typeof body.model === "string" ? body.model : "?", parts: summarizeUserContent(body) });
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of [
        { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "MOCK OK" }, finish_reason: null }] },
        { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [] }));
  });
  await new Promise<void>((done) => mock.listen(0, "127.0.0.1", () => done()));
  const mockPort = (mock.address() as AddressInfo).port;

  let engine: ReturnType<typeof spawn> | null = null;
  let engineLog = "";
  try {
    const bundle = spawnSync("bun", ["build", join(serverRoot, "src", "opencode-plugins", "openwork-pdf-attachments.ts"), "--outdir", pluginDir, "--target", "node", "--format", "esm"], { cwd: serverRoot, encoding: "utf8" });
    expect(bundle.status, bundle.stderr).toBe(0);
    const copyWasm = spawnSync(process.execPath, [join(serverRoot, "scripts", "copy-pdfium-wasm.mjs"), pluginDir], { cwd: serverRoot, encoding: "utf8" });
    expect(copyWasm.status, copyWasm.stderr).toBe(0);
    expect((await readdir(pluginDir)).sort()).toEqual(["openwork-pdf-attachments.js", "pdfium.wasm"]);

    const model = (input: string[]) => ({ name: input.join("+"), attachment: input.length > 1, tool_call: true, reasoning: false, temperature: true, modalities: { input, output: ["text"] }, limit: { context: 128000, output: 4096 }, cost: { input: 0, output: 0 } });
    await Promise.all([mkdir(home, { recursive: true }), mkdir(workspace, { recursive: true })]);
    await writeFile(join(workspace, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [join(pluginDir, "openwork-pdf-attachments.js")],
      provider: {
        mock: {
          npm: "@ai-sdk/openai-compatible",
          name: "Mock provider",
          options: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: "test" },
          models: { vision: model(["text", "image"]), text: model(["text"]), native: model(["text", "image", "pdf"]) },
        },
      },
    }, null, 2));

    const port = 14000 + Math.floor(Math.random() * 2000);
    const credentials = "pdf-routing-spec";
    engine = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_STATE_HOME: join(home, ".local", "state"),
        OPENCODE_SERVER_USERNAME: credentials,
        OPENCODE_SERVER_PASSWORD: credentials,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    engine.stdout?.on("data", (chunk: Buffer) => { engineLog += chunk.toString(); });
    engine.stderr?.on("data", (chunk: Buffer) => { engineLog += chunk.toString(); });

    const authorization = `Basic ${Buffer.from(`${credentials}:${credentials}`).toString("base64")}`;
    const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(`http://127.0.0.1:${port}${path}?directory=${encodeURIComponent(workspace)}`, {
        method,
        headers: { "content-type": "application/json", authorization },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 400)}`);
      return text ? JSON.parse(text) : null;
    };
    let healthy = false;
    for (let attempt = 0; attempt < 150 && !healthy; attempt += 1) {
      try {
        healthy = (await fetch(`http://127.0.0.1:${port}/global/health`, { headers: { authorization }, signal: AbortSignal.timeout(2_000) })).ok;
      } catch {
        await new Promise((wait) => setTimeout(wait, 200));
      }
    }
    expect(healthy, engineLog).toBe(true);

    const version = spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim();
    const pdf = buildTestPdf(["Quarterly revenue report", "Second page", null]);
    const pdfPart = { type: "file", mime: "application/pdf", filename: "report.pdf", url: pdfDataUrl(pdf) };
    const observed: Record<string, { provider: string[]; persisted: string[]; reply: string }> = {};
    for (const modelID of ["vision", "text", "native"]) {
      const session = await api("POST", "/session", { title: `pdf ${modelID}` });
      const sessionId = isRecord(session) && typeof session.id === "string" ? session.id : "";
      expect(sessionId).not.toBe("");
      const before = requests.length;
      const result = await api("POST", `/session/${sessionId}/message`, { model: { providerID: "mock", modelID }, parts: [pdfPart, { type: "text", text: "Summarize this." }] });
      const reply = isRecord(result) && Array.isArray(result.parts)
        ? result.parts.filter(isRecord).filter((part) => part.type === "text").map((part) => String(part.text)).join("")
        : "";
      const persisted = await api("GET", `/session/${sessionId}/message`);
      const user = Array.isArray(persisted) ? persisted.filter(isRecord).find((message) => isRecord(message.info) && message.info.role === "user") : undefined;
      observed[modelID] = {
        provider: requests.slice(before).flatMap((request) => request.parts),
        persisted: partsOf(user).map((part) => (part.type === "file" ? `file:${String(part.mime)}` : String(part.type))),
        reply,
      };
    }

    expect(observed.vision.provider).toEqual(["image_url:data:image/png", "image_url:data:image/png", "image_url:data:image/png", "text:note", "text:Summarize this."]);
    expect(observed.text.provider).toEqual(["text:note", "text:Summarize this."]);
    expect(observed.native.provider).toEqual(["file:report.pdf", "text:Summarize this."]);
    for (const modelID of ["vision", "text", "native"]) {
      expect(observed[modelID].reply).toBe("MOCK OK");
      expect(observed[modelID].persisted).toEqual(["file:application/pdf", "text"]);
    }
    const derived = await readdir(join(workspace, ".opencode", "openwork", "inbox", "pdf-pages"));
    expect(derived).toHaveLength(1);

    evidence.recordAssertionEvidence(
      "Inside the real engine, an image-capable model received page images plus text, a text-only model received text, and a PDF-capable model received the PDF itself",
      `OpenCode ${version} with the bundled plugin and sibling pdfium.wasm; provider saw vision=${observed.vision.provider.join(",")} text=${observed.text.provider.join(",")} native=${observed.native.provider.join(",")}; every reply completed and every persisted user message kept its application/pdf part.`,
      true,
    );
  } finally {
    engine?.kill("SIGTERM");
    await new Promise<void>((done) => mock.close(() => done()));
    await rm(scratch, { recursive: true, force: true });
  }
});
