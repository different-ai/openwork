/** Fixtures for the packaged sandbox journey. No desktop/server implementation imports. */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, open, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";

export const GUEST_TOOLS = ["edit", "glob", "grep", "read", "shell", "write"];
export const profiles = {
  fable: { model: "claude-fable-5-2", name: "Fable 5.2", provider: "packaged_anthropic", npm: "@ai-sdk/anthropic", upstream: "https://api.anthropic.com", keyEnv: "ANTHROPIC_API_KEY" },
  sol: { model: "gpt-6.2-sol", name: "GPT 6.2 Sol fast", provider: "packaged_openai", npm: "@ai-sdk/openai", upstream: "https://api.openai.com", keyEnv: "OPENAI_API_KEY" },
};
export type ModelKey = keyof typeof profiles;
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function rawMessages(body: unknown) {
  if (!isRecord(body) || !isRecord(body.messages) || !Array.isArray(body.messages.data)) throw new Error("Native snapshot has no message page");
  const rows = body.messages.data.filter(isRecord);
  return "cursor" in body.messages ? rows.toReversed() : rows;
}

/** Native idle markers are messages too; completion belongs to a new assistant stop message. */
export function hasStoppedAssistantAnswer(body: unknown, previousMessageIds: ReadonlySet<string>) {
  return rawMessages(body).some(message => typeof message.id === "string" && !previousMessageIds.has(message.id)
    && message.type === "assistant" && message.finish === "stop" && Array.isArray(message.content)
    && message.content.some(part => isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.length > 0));
}

export function redact(text: string, secrets: readonly string[]) {
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[redacted]");
  return text;
}

/** Opt-in launch controls are set afterwards, never inherited from an agent's engine. */
export function isolatedParentEnvironment(env: NodeJS.ProcessEnv) {
  const keep = /^(PATH|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|TZ|TERM|CI|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/;
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => keep.test(name) && value !== undefined));
}

export async function fileSha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Content identity of the actual signed bundle, not a claim about the current checkout. */
export async function bundleIdentity(bundle: string) {
  const canonical = await realpath(bundle);
  const entries: { path: string; kind: string; mode: number; sha256?: string; target?: string }[] = [];
  async function walk(directory: string, parent = "") {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = join(directory, name);
      const path = parent ? `${parent}/${name}` : name;
      const info = await lstat(absolute);
      const mode = info.mode & 0o7777;
      if (info.isSymbolicLink()) {
        const destination = await realpath(absolute);
        if (!destination.startsWith(`${canonical}/`)) throw new Error(`Packaged bundle symlink escapes the artifact: ${path}`);
        entries.push({ path, kind: "symlink", mode, target: await readlink(absolute) });
      } else if (info.isDirectory()) {
        entries.push({ path, kind: "directory", mode });
        await walk(absolute, path);
      } else if (info.isFile()) entries.push({ path, kind: "file", mode, sha256: await fileSha256(absolute) });
      else throw new Error(`Unsupported packaged bundle entry: ${path}`);
    }
  }
  await walk(canonical);
  const sha256 = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  return { sha256, entryCount: entries.length, algorithm: "sha256(sorted relative path + kind + permission mode + file SHA256 or symlink target), v1" };
}

export async function packagedBundle(binary: string) {
  const absolute = resolve(binary);
  const marker = absolute.lastIndexOf(".app/Contents/MacOS/");
  if (marker < 0 || absolute.startsWith("/Applications/")) throw new Error("Use a branch-built .app outside /Applications, not a development Electron binary");
  const bundle = absolute.slice(0, marker + 4);
  const resources = join(bundle, "Contents/Resources");
  await Promise.all([absolute, join(resources, "app.asar"), join(resources, "app-dist"), join(resources, "opencode-plugins/openwork-sandbox-v2.js")].map(path => access(path)));
  const archive = await open(join(resources, "app.asar"), "r");
  let archivePaths: string[];
  try {
    const prefix = Buffer.alloc(16);
    await archive.read(prefix, 0, 16, 0);
    const size = prefix.readUInt32LE(12);
    if (size < 2 || size > 32_000_000) throw new Error("Invalid ASAR header size");
    const header = Buffer.alloc(size);
    await archive.read(header, 0, size, 16);
    const parsed: unknown = JSON.parse(header.toString("utf8"));
    const walk = (value: unknown, parent = ""): string[] => {
      if (!isRecord(value) || !isRecord(value.files)) return [];
      return Object.entries(value.files).flatMap(([name, entry]) => {
        const path = parent ? `${parent}/${name}` : name;
        return [path, ...walk(entry, path)];
      });
    };
    archivePaths = walk(parsed);
  } finally { await archive.close(); }
  if (!archivePaths.includes("server/dist/embedded.js")) throw new Error("ASAR does not contain the packaged embedded server");
  const stagedRuntime = archivePaths.filter(path => /node_modules\/.+(?:microsandbox|superradcompany)/.test(path));
  if (!stagedRuntime.length) throw new Error("ASAR does not contain the staged microsandbox runtime");
  const [identity, binarySha256, asarSha256] = await Promise.all([bundleIdentity(bundle), fileSha256(absolute), fileSha256(join(resources, "app.asar"))]);
  return { binary: absolute, bundle, resources, embeddedServer: "app.asar/server/dist/embedded.js", stagedRuntime, identity, binarySha256, asarSha256 };
}

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture has no loopback port");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

/** This is explicitly a disposable signed-out Den contract fixture, not production flag evidence. */
export async function sandboxDenFixture(enabled = true) {
  const reads: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname.replace(/^\/api\/den/, "");
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "content-type": "application/json" };
    if (request.method === "OPTIONS") { response.writeHead(204, headers).end(); return; }
    reads.push(path);
    const body = path === "/v1/features" ? { features: { sandboxTools: enabled } }
      : path === "/v1/app-version" ? { minAppVersion: "0.0.0", latestAppVersion: "0.0.0", publishedDesktopVersions: [] }
      : null;
    response.writeHead(body ? 200 : 404, headers).end(JSON.stringify(body ?? { error: "fixture_not_found" }));
  });
  return { url: await listen(server), reads, close: () => close(server) };
}

export type InferenceRecord = {
  phase: string; path: string; requestedModel: string; offeredTools: string[];
  codeModeTools: string[]; responseModel: string | null; status: number;
  receivedAt?: number; responseServiceTier?: string | null; upstreamAttempts?: { model: string; status: number }[];
  completed: boolean; requestContainedHostSecret: boolean; responseError?: string; tuning?: string;
};
export function offeredToolNames(body: Record<string, unknown>) {
  return (Array.isArray(body.tools) ? body.tools.filter(isRecord) : []).map(tool =>
    typeof tool.name === "string" ? tool.name : isRecord(tool.function) && typeof tool.function.name === "string" ? tool.function.name : `<${String(tool.type)}>`).sort();
}
export function hasOnlyDirectGuestTools(entries: readonly InferenceRecord[]) {
  return entries.length > 0 && entries.every(entry => JSON.stringify(entry.offeredTools) === JSON.stringify(GUEST_TOOLS) && entry.codeModeTools.length === 0);
}
function responseField(text: string, field: "model" | "service_tier") {
  const models: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const raw = line.startsWith("data:") ? line.slice(5).trim() : line;
    try {
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value)) continue;
      for (const candidate of [value, value.message, value.response]) if (isRecord(candidate) && typeof candidate[field] === "string") models.push(candidate[field]);
    } catch { /* SSE framing is not a JSON response. */ }
  }
  return models.at(-1) ?? null;
}

/** Only this closure holds the upstream credential. Disk/config receive a random loopback-only token. */
export async function inferenceFixture(model: ModelKey, realKey: string, state: { phase: string; hostSecret: string }) {
  const profile = profiles[model];
  const token = `packaged-proof-${randomBytes(24).toString("base64url")}`;
  const records: InferenceRecord[] = [];
  const lifetime = new AbortController();
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const credential = request.headers["x-api-key"] ?? String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (credential !== token) { response.writeHead(401).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try { body = JSON.parse(raw); } catch { response.writeHead(400).end(); return; }
    if (!isRecord(body) || typeof body.model !== "string") { response.writeHead(400).end(); return; }
    const path = (request.url ?? "/").replace(/^\/(?!v1\/)/, "/v1/");
    const entry: InferenceRecord = { receivedAt: Date.now(), phase: state.phase, path, requestedModel: body.model, offeredTools: offeredToolNames(body),
      codeModeTools: [...raw.replaceAll("\\n", "\n").matchAll(/^\s*- tools\.([A-Za-z0-9_.]+)\(/gm)].map(match => match[1] ?? ""),
      status: 0, responseModel: null, completed: false, requestContainedHostSecret: raw.includes(state.hostSecret) };
    records.push(entry); // Visible immediately, allowing an active-turn Settings interaction.
    if (model === "sol") {
      if (path.endsWith("/chat/completions")) body.reasoning_effort = "low";
      else body.reasoning = { ...(isRecord(body.reasoning) ? body.reasoning : {}), effort: "low" };
      body.service_tier = "priority";
      entry.tuning = "reasoning.effort=low; service_tier=priority";
    } else {
      body.output_config = { ...(isRecord(body.output_config) ? body.output_config : {}), effort: "low" };
      entry.tuning = "output_config.effort=low";
    }
    try {
      const headers: Record<string, string> = {};
      for (const name of ["content-type", "accept", "anthropic-version", "anthropic-beta", "openai-beta", "openai-organization", "openai-project"]) {
        const value = request.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      if (model === "fable") headers["x-api-key"] = realKey;
      else headers.authorization = `Bearer ${realKey}`;
      const requestModel = (payload: Record<string, unknown>) => fetch(`${profile.upstream}${path}`, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(600_000)]) });
      let upstream = await requestModel(body);
      entry.upstreamAttempts = [{ model: entry.requestedModel, status: upstream.status }];
      // The checked-in gateway model metadata lists a fast alias; do not try a prior generation.
      if (model === "sol" && [400, 403, 404, 422].includes(upstream.status)) {
        const rejection = await upstream.text();
        entry.responseError = redact(rejection.slice(0, 2000), [realKey, token]);
        upstream = await requestModel({ ...body, model: "gpt-6.2-sol-fast" });
        entry.upstreamAttempts.push({ model: "gpt-6.2-sol-fast", status: upstream.status });
      }
      entry.status = upstream.status;
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      let text = "";
      const decoder = new TextDecoder();
      const reader = upstream.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
            response.write(value);
          }
        } finally { reader.releaseLock(); }
      }
      text += decoder.decode();
      entry.responseModel = responseField(text, "model");
      entry.responseServiceTier = responseField(text, "service_tier");
      if (!upstream.ok) entry.responseError = redact(text.slice(0, 2000), [realKey, token]);
      entry.completed = true;
      response.end();
    } catch {
      entry.status = 502;
      entry.completed = true;
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(502); response.end(); });
  });
  return { url: `${await listen(server)}/v1`, token, records, close: () => { lifetime.abort(); return close(server); } };
}

/** Audit only owned engine config files; never inspect a person's home/config/history. */
export async function configContainsNoKey(paths: string[], key: string) {
  return (await Promise.all(paths.map(path => readFile(path, "utf8")))).every(text => !text.includes(key));
}
