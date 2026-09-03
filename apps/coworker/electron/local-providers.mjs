/**
 * What is already on this Mac that a coworker could use: a ChatGPT sign-in
 * kept by Codex, a Claude Code sign-in, a GitHub Copilot sign-in, providers
 * already connected in OpenCode's shared credential store, API keys in the
 * app's own environment, and local model servers answering on loopback.
 *
 * Detection is presence-only. A file is opened just long enough to learn its
 * shape; no secret value is kept, returned, or logged, and a missing file or a
 * silent port is "not found", never an error. The connect helpers below turn a
 * sign-in file into the exact credential shape the engine stores itself, so
 * the main process can hand it over loopback and forget it.
 *
 * No Electron imports here: `node --test electron/local-providers.test.mjs`
 * exercises this module against a temporary HOME.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const NETWORK_TIMEOUT_MS = 200;
const KEYCHAIN_TIMEOUT_MS = 1_500;
const CLAUDE_CODE_KEYCHAIN_SERVICE = "Claude Code-credentials";
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

/** API key names the engine itself reads, and the provider each one connects. */
export const ENVIRONMENT_KEYS = [
  { name: "OPENAI_API_KEY", providerId: "openai", label: "OpenAI" },
  { name: "ANTHROPIC_API_KEY", providerId: "anthropic", label: "Anthropic" },
  { name: "OPENROUTER_API_KEY", providerId: "openrouter", label: "OpenRouter" },
  { name: "GEMINI_API_KEY", providerId: "google", label: "Google" },
  { name: "GOOGLE_API_KEY", providerId: "google", label: "Google" },
  { name: "GOOGLE_GENERATIVE_AI_API_KEY", providerId: "google", label: "Google" },
  { name: "XAI_API_KEY", providerId: "xai", label: "xAI" },
];

/** Local model servers and where they answer by default; Ollama honours its own OLLAMA_HOST. */
export const LOCAL_MODEL_SERVERS = [
  { id: "ollama", label: "Ollama", defaultAddress: "http://127.0.0.1:11434", hostEnv: "OLLAMA_HOST" },
  { id: "lm-studio", label: "LM Studio", defaultAddress: "http://127.0.0.1:1234", hostEnv: "LMSTUDIO_HOST" },
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Where Codex keeps its sign-in: `$CODEX_HOME/auth.json`, else `~/.codex/auth.json`. */
export function codexAuthPath(env, homeDir) {
  const codexHome = nonEmpty(env.CODEX_HOME) ? env.CODEX_HOME.trim() : path.join(homeDir, ".codex");
  return path.join(codexHome, "auth.json");
}

export function configHome(env, homeDir) {
  return nonEmpty(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME.trim() : path.join(homeDir, ".config");
}

export function dataHome(env, homeDir) {
  return nonEmpty(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME.trim() : path.join(homeDir, ".local", "share");
}

/** OpenCode's credential store, shared by this app, OpenWork Desktop, and the OpenCode CLI. */
export function opencodeAuthPath(env, homeDir) {
  return path.join(dataHome(env, homeDir), "opencode", "auth.json");
}

export function copilotConfigDir(env, homeDir) {
  return path.join(configHome(env, homeDir), "github-copilot");
}

export function claudeCodeCredentialsPath(env, homeDir) {
  const claudeDir = nonEmpty(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR.trim() : path.join(homeDir, ".claude");
  return path.join(claudeDir, ".credentials.json");
}

/** Engine provider keys owned by the OpenWork account sync; never "found on this Mac". */
export function isCloudManagedProviderId(providerId) {
  return /^lpr_/i.test(providerId) || providerId.trim() === "openwork";
}

/**
 * The shape of a Codex sign-in without its values: `chatgpt` when the tokens
 * are there, `apikey` when Codex saved an OpenAI key instead, otherwise null.
 */
export function codexSignInMode(parsed) {
  if (!isRecord(parsed)) return null;
  const tokens = parsed.tokens;
  if (isRecord(tokens) && nonEmpty(tokens.access_token) && nonEmpty(tokens.refresh_token)) return "chatgpt";
  if (nonEmpty(parsed.OPENAI_API_KEY)) return "apikey";
  return null;
}

/** The expiry (ms since epoch) a JWT carries, or 0 when it cannot be read: the engine then refreshes first. */
export function jwtExpiryMs(token) {
  const segments = String(token ?? "").split(".");
  if (segments.length < 2) return 0;
  try {
    const payload = JSON.parse(Buffer.from(segments[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return isRecord(payload) && typeof payload.exp === "number" && Number.isFinite(payload.exp) ? Math.round(payload.exp * 1000) : 0;
  } catch {
    return 0;
  }
}

export class SignInImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SignInImportError";
    this.code = code;
  }
}

/**
 * Turn Codex's sign-in file into the credential the engine's own ChatGPT
 * sign-in would have stored (the same OAuth client and token shape), or into
 * an API key when Codex kept one. Values pass straight through to the caller,
 * who hands them to the engine and drops them.
 */
export function codexAuthFromFile(parsed) {
  const mode = codexSignInMode(parsed);
  if (mode === "chatgpt") {
    const tokens = parsed.tokens;
    return {
      type: "oauth",
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      expires: jwtExpiryMs(tokens.access_token),
      ...(nonEmpty(tokens.account_id) ? { accountId: tokens.account_id } : {}),
    };
  }
  if (mode === "apikey") return { type: "api", key: parsed.OPENAI_API_KEY.trim() };
  throw new SignInImportError("missing", "Codex is not signed in on this Mac. Sign in with Codex, then Connect.");
}

function copilotToken(parsed) {
  if (!isRecord(parsed)) return "";
  for (const [host, entry] of Object.entries(parsed)) {
    if (!host.startsWith("github.com") || !isRecord(entry)) continue;
    if (nonEmpty(entry.oauth_token)) return entry.oauth_token;
  }
  return "";
}

/** Whether a Copilot hosts/apps file carries a github.com sign-in; values are not returned. */
export function copilotSignedIn(parsed) {
  return copilotToken(parsed) !== "";
}

/**
 * The credential the engine's own Copilot sign-in stores: the GitHub token is
 * the long-lived part it exchanges for short Copilot sessions, so it goes in
 * as the refresh token with nothing else.
 */
export function copilotAuthFromFile(parsed) {
  const token = copilotToken(parsed);
  if (!token) throw new SignInImportError("missing", "GitHub Copilot is not signed in on this Mac. Sign in with Copilot in your editor, then Connect.");
  return { type: "oauth", refresh: token, access: "", expires: 0 };
}

/** Normalise an OLLAMA_HOST-style value (`0.0.0.0:11434`, `host:port`, or a URL) into an http(s) origin. */
export function normalizeServerAddress(value, fallback) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.hostname === "0.0.0.0" || url.hostname === "::" || url.hostname === "[::]") url.hostname = "127.0.0.1";
    return url.origin;
  } catch {
    return fallback;
  }
}

/** The address a person typed for an OpenAI-compatible server, as the engine wants it (origin + `/v1`). */
export function normalizeOpenAiCompatibleAddress(value) {
  const raw = String(value ?? "").trim().replace(/\/+$/, "");
  if (!raw) throw new Error("Enter the server address, for example http://127.0.0.1:1234.");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) {
    throw new Error("The address must start with http:// or https://.");
  }
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("That address is not valid. Use a form like http://127.0.0.1:1234 or https://ai.example.com/v1.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The address must start with http:// or https://.");
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname === "" ? "/v1" : pathname;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function modelIdsFromOpenAiList(payload) {
  const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  return data.map((entry) => (isRecord(entry) && nonEmpty(entry.id) ? entry.id.trim() : "")).filter(Boolean);
}

function modelNamesFromOllamaTags(payload) {
  const models = isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];
  return models
    .map((entry) => (isRecord(entry) ? (nonEmpty(entry.model) ? entry.model : nonEmpty(entry.name) ? entry.name : "") : ""))
    .map((name) => name.trim())
    .filter(Boolean);
}

async function fetchJsonBounded(fetchImpl, url, init, timeoutMs) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * Ask an OpenAI-compatible server which models it serves. `key` is optional
 * and only ever travels in the request header.
 */
export async function listOpenAiCompatibleModels(address, key, { fetchImpl = fetch, timeoutMs = 5_000 } = {}) {
  const base = normalizeOpenAiCompatibleAddress(address);
  let payload;
  try {
    payload = await fetchJsonBounded(
      fetchImpl,
      `${base}/models`,
      { headers: nonEmpty(key) ? { Authorization: `Bearer ${key.trim()}` } : {} },
      timeoutMs,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/HTTP 401|HTTP 403/.test(message)) throw new Error("The server did not accept the key.");
    throw new Error(`Nothing answered at ${base}. Check the address and that the server is running.`);
  }
  const models = [...new Set(modelIdsFromOpenAiList(payload))];
  if (models.length === 0) throw new Error(`${base} answered but listed no models.`);
  return { address: base, models };
}

/** Local servers answering right now, with the models they list. */
async function probeLocalServers(env, fetchImpl, timeoutMs) {
  const results = await Promise.all(LOCAL_MODEL_SERVERS.map(async (server) => {
    const address = normalizeServerAddress(env[server.hostEnv], server.defaultAddress);
    try {
      const models = server.id === "ollama"
        ? modelNamesFromOllamaTags(await fetchJsonBounded(fetchImpl, `${address}/api/tags`, {}, timeoutMs))
        : modelIdsFromOpenAiList(await fetchJsonBounded(fetchImpl, `${address}/v1/models`, {}, timeoutMs));
      return { server, address, models: [...new Set(models)] };
    } catch {
      return null;
    }
  }));
  return results.filter(Boolean);
}

function runKeychainProbe(service) {
  return new Promise((resolve) => {
    // `find-generic-password` without `-w` prints attributes only, never the secret.
    const child = execFile("security", ["find-generic-password", "-s", service], { timeout: KEYCHAIN_TIMEOUT_MS }, (error) => {
      resolve(!error);
    });
    child.stdout?.resume();
    child.stderr?.resume();
  });
}

function pluralModels(count) {
  return `${count} model${count === 1 ? "" : "s"}`;
}

/**
 * Everything on this Mac a coworker could use, as flat findings. Each has a
 * stable `id`, a plain `label`, one line of `detail`, the engine `providerId`
 * it maps to, and `how` connecting works: `import` (the engine can take the
 * sign-in as it is), `add` (a local server the engine can be pointed at),
 * `in-use` (already available), or `unavailable` (with the reason).
 */
export async function detectLocalProviders({
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
  fetchImpl = fetch,
  timeoutMs = NETWORK_TIMEOUT_MS,
  keychainProbe = runKeychainProbe,
  log = () => undefined,
} = {}) {
  const found = [];

  const codex = await readJsonFile(codexAuthPath(env, homeDir));
  const codexMode = codexSignInMode(codex);
  if (codexMode === "chatgpt") {
    found.push({
      id: "codex",
      kind: "codex",
      label: "ChatGPT (signed in with Codex)",
      detail: "Uses your ChatGPT subscription for coworkers on this Mac.",
      providerId: "openai",
      how: "import",
      reason: "",
    });
  } else if (codexMode === "apikey") {
    found.push({
      id: "codex",
      kind: "codex",
      label: "OpenAI key (saved by Codex)",
      detail: "Uses the OpenAI key Codex keeps on this Mac.",
      providerId: "openai",
      how: "import",
      reason: "",
    });
  }

  const claudeFile = await readJsonFile(claudeCodeCredentialsPath(env, homeDir));
  const claudeSignedIn = isRecord(claudeFile) || (platform === "darwin" && await keychainProbe(CLAUDE_CODE_KEYCHAIN_SERVICE).catch(() => false));
  if (claudeSignedIn) {
    found.push({
      id: "claude-code",
      kind: "claude-code",
      label: "Claude (signed in with Claude Code)",
      detail: "",
      providerId: "anthropic",
      how: "unavailable",
      reason: "Claude subscriptions only work inside Claude Code. Add an Anthropic key instead.",
    });
  }

  const copilotDir = copilotConfigDir(env, homeDir);
  const copilotFiles = await Promise.all([readJsonFile(path.join(copilotDir, "apps.json")), readJsonFile(path.join(copilotDir, "hosts.json"))]);
  if (copilotFiles.some(copilotSignedIn)) {
    found.push({
      id: "copilot",
      kind: "copilot",
      label: "GitHub Copilot (signed in on this Mac)",
      detail: "Uses your Copilot subscription for coworkers on this Mac.",
      providerId: "github-copilot",
      how: "import",
      reason: "",
    });
  }

  const store = await readJsonFile(opencodeAuthPath(env, homeDir));
  if (isRecord(store)) {
    for (const providerId of Object.keys(store).filter((id) => id.trim() && !isCloudManagedProviderId(id)).sort()) {
      found.push({
        id: `opencode:${providerId}`,
        kind: "opencode",
        label: `${providerId} (connected in OpenCode)`,
        detail: "Already available to coworkers on this Mac; OpenWork Desktop shares it.",
        providerId,
        how: "in-use",
        reason: "",
      });
    }
  }

  const seenEnvProviders = new Set();
  for (const entry of ENVIRONMENT_KEYS) {
    if (!nonEmpty(env[entry.name]) || seenEnvProviders.has(entry.providerId)) continue;
    seenEnvProviders.add(entry.providerId);
    found.push({
      id: `env:${entry.name}`,
      kind: "env",
      label: `${entry.label} key in your environment`,
      detail: `${entry.name} is set, so coworkers on this Mac can already use it.`,
      providerId: entry.providerId,
      how: "in-use",
      reason: "",
      envName: entry.name,
    });
  }

  for (const { server, address, models } of await probeLocalServers(env, fetchImpl, timeoutMs)) {
    found.push({
      id: `server:${server.id}`,
      kind: "server",
      label: `${server.label} (running on this Mac)`,
      detail: models.length > 0
        ? `${pluralModels(models.length)} ready. Uses them for coworkers on this Mac; no account needed.`
        : "Running, but no models are downloaded yet.",
      providerId: server.id,
      how: models.length > 0 ? "add" : "unavailable",
      reason: models.length > 0 ? "" : `Download a model in ${server.label} first, then Refresh.`,
      address,
      models,
    });
  }

  log(`local providers detected: ${found.map((finding) => finding.id).join(", ") || "none"}`);
  return { found, checkedAt: Date.now() };
}

function slugify(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** A runtime provider id for a server the person added by hand; never collides with a well-known provider. */
export function customProviderId(name) {
  const slug = slugify(name);
  return `custom-${slug || "server"}`;
}

/**
 * The engine provider entry for an OpenAI-compatible server (a local Ollama or
 * LM Studio, or one the person typed in): the compatible SDK, the address, and
 * the models it listed. The key, when there is one, goes to the credential
 * store separately, never into this config.
 */
export function openAiCompatibleProviderConfig({ name, address, models }) {
  const ids = [...new Set((models ?? []).map((model) => String(model ?? "").trim()).filter(Boolean))];
  if (ids.length === 0) throw new Error("A server needs at least one model.");
  return {
    npm: OPENAI_COMPATIBLE_NPM,
    name: String(name ?? "").trim() || "Custom server",
    options: { baseURL: address },
    models: Object.fromEntries(ids.map((id) => [id, { name: id, tool_call: true }])),
  };
}

/** The runtime provider patch that connects a detected local server. */
export function localServerProviderPatch(finding) {
  const server = LOCAL_MODEL_SERVERS.find((entry) => entry.id === finding.providerId);
  if (!server || !finding.address) throw new Error("This is not a local model server.");
  return {
    [server.id]: openAiCompatibleProviderConfig({
      name: server.label,
      address: `${finding.address}/v1`,
      models: finding.models ?? [],
    }),
  };
}
