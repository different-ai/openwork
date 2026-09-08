import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ServerConfig } from "./types.js";
import { externalFetch } from "./server-fetch.js";
import { runtimeStorageDir } from "./runtime-db.js";
import {
  mergeRuntimeProviderUpdate,
  readGlobalRuntimeOpencodeConfig,
  runtimeDisabledProviderList,
  runtimeProviderMap,
  writeGlobalRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";

export const ANONYMOUS_INFERENCE_PROVIDER_ID = "openwork-free";
export const ANONYMOUS_INFERENCE_PROVIDER_NAME = "OpenWork Models (Free)";
export const ANONYMOUS_INFERENCE_MODEL_ID = "openai/gpt-5.6-luna";

const PREVIOUS_ANONYMOUS_INFERENCE_MODEL_ID = "deepseek/deepseek-v4-flash";

const DEFAULT_ANONYMOUS_INFERENCE_ORIGIN = "https://inference.openworklabs.com";
const LOCAL_ROUTE_PREFIX = "/anonymous-inference/v1";
const LOCAL_TOKEN_PREFIX = "owf_local_";
const REQUEST_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const ERROR_BODY_LIMIT_BYTES = 64 * 1024;
const SESSION_TIMEOUT_MS = 10_000;
const RESPONSE_HEADER_TIMEOUT_MS = 30_000;
const REQUEST_BODY_TIMEOUT_MS = 15_000;
const REQUEST_LIFETIME_MS = 5 * 60_000;
const TOKEN_EXPIRY_SKEW_MS = 30_000;
const REMOTE_FAILURE_CACHE_DEFAULT_MS = 30_000;
const REMOTE_FAILURE_CACHE_MAX_MS = 60_000;
const MAX_REMOTE_FAILURE_CACHE_ENTRIES = 64;

type AnonymousInferenceLogger = {
  log: (level: "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>) => void;
};

type AnonymousSession = {
  token: string;
  expiresAt: number;
};

type CachedFailure = {
  expiresAt: number;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Uint8Array;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enabledFlag(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function resolveAnonymousInferenceOrigin(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.OPENWORK_FREE_INFERENCE_ORIGIN?.trim();
  const raw = configured || DEFAULT_ANONYMOUS_INFERENCE_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OPENWORK_FREE_INFERENCE_ORIGIN must be a valid URL");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new Error("OPENWORK_FREE_INFERENCE_ORIGIN must contain only an origin");
  }
  const localDevelopment = environment.OPENWORK_DEV_MODE === "1" || environment.NODE_ENV === "test";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localDevelopment && isLoopbackHostname(url.hostname))) {
    throw new Error("OPENWORK_FREE_INFERENCE_ORIGIN must use HTTPS (localhost HTTP is allowed only in development and tests)");
  }
  return url.origin;
}

function anonymousInferenceDisabled(environment: NodeJS.ProcessEnv): boolean {
  return enabledFlag(environment.OPENWORK_DISABLE_FREE_INFERENCE)
    || enabledFlag(environment.OPENWORK_DISABLE_HOSTED_MODELS)
    || enabledFlag(environment.VITE_DISABLE_OPENWORK_MODELS);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isGeneratedModel(value: unknown, id: string, name: string, temperature: boolean): boolean {
  if (!isRecord(value)) return false;
  const generatedKeys = ["id", "name", "attachment", "reasoning", "temperature", "tool_call", "limit", "modalities"];
  const hasFixedOptions = hasExactKeys(value, [...generatedKeys, "options"]);
  if (!hasExactKeys(value, generatedKeys) && !hasFixedOptions) {
    return false;
  }
  if (value.id !== id
    || value.name !== name
    || value.attachment !== false
    || value.reasoning !== false
    || value.temperature !== temperature
    || value.tool_call !== true
    || !isRecord(value.limit)
    || !hasExactKeys(value.limit, ["context", "input", "output"])
    || value.limit.context !== 135_168
    || value.limit.input !== 131_072
    || value.limit.output !== 4_096
    || !isRecord(value.modalities)
    || !hasExactKeys(value.modalities, ["input", "output"])) {
    return false;
  }
  const input = value.modalities.input;
  const output = value.modalities.output;
  if (!Array.isArray(input) || input.length !== 1 || input[0] !== "text"
    || !Array.isArray(output) || output.length !== 1 || output[0] !== "text") return false;
  if (!hasFixedOptions) return true;
  return id === ANONYMOUS_INFERENCE_MODEL_ID
    && isRecord(value.options)
    && hasExactKeys(value.options, ["reasoningEffort"])
    && value.options.reasoningEffort === "none";
}

function isOwnedProvider(value: unknown): boolean {
  if (!isRecord(value)
    || !hasExactKeys(value, ["name", "npm", "options", "models"])
    || value.name !== ANONYMOUS_INFERENCE_PROVIDER_NAME
    || value.npm !== "@openrouter/ai-sdk-provider") {
    return false;
  }
  const options = value.options;
  const models = value.models;
  if (!isRecord(options)
    || !hasExactKeys(options, ["apiKey", "baseURL"])
    || !isRecord(models)
    || Object.keys(models).length !== 1) return false;
  if (typeof options.baseURL !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/anonymous-inference\/v1$/.test(options.baseURL)) {
    return false;
  }
  if (typeof options.apiKey !== "string" || !/^owf_local_[A-Za-z0-9_-]{43}$/.test(options.apiKey)) return false;
  return isGeneratedModel(models[ANONYMOUS_INFERENCE_MODEL_ID], ANONYMOUS_INFERENCE_MODEL_ID, "GPT-5.6 Luna", false)
    || isGeneratedModel(models[PREVIOUS_ANONYMOUS_INFERENCE_MODEL_ID], PREVIOUS_ANONYMOUS_INFERENCE_MODEL_ID, "DeepSeek V4 Flash", true);
}

function jsonError(status: number, code: string, message: string, headers?: HeadersInit): Response {
  return new Response(JSON.stringify({ error: { message, type: "openwork_anonymous_error", code } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorCode(body: Uint8Array): string | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!isRecord(parsed) || !isRecord(parsed.error)) return null;
    return typeof parsed.error.code === "string" ? parsed.error.code : null;
  } catch {
    return null;
  }
}

function forwardedHeaders(headers: Headers): [string, string][] {
  return ["content-type", "retry-after", "x-request-id"].flatMap((name) => {
    const value = headers.get(name);
    return value ? [[name, value] as [string, string]] : [];
  });
}

function responseFromCachedFailure(failure: CachedFailure): Response {
  return new Response(failure.body.slice(), {
    status: failure.status,
    statusText: failure.statusText,
    headers: failure.headers,
  });
}

class BodyReadDeadlineError extends Error {}

async function readBoundedBody(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    if (signal.aborted) {
      await reader.cancel(signal.reason).catch(() => undefined);
      signal.throwIfAborted();
    }
    if (Date.now() >= deadlineAt) {
      await reader.cancel(new BodyReadDeadlineError()).catch(() => undefined);
      throw new BodyReadDeadlineError();
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let chunk: { result: Awaited<ReturnType<typeof reader.read>> } | { deadline: true } | { aborted: true };
    try {
      chunk = await Promise.race([
        reader.read().then((result) => ({ result })),
        new Promise<{ deadline: true }>((resolve) => {
          timeout = setTimeout(() => resolve({ deadline: true }), Math.max(1, deadlineAt - Date.now()));
        }),
        new Promise<{ aborted: true }>((resolve) => {
          abortListener = () => resolve({ aborted: true });
          if (signal.aborted) resolve({ aborted: true });
          else signal.addEventListener("abort", abortListener, { once: true });
        }),
      ]);
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener) signal.removeEventListener("abort", abortListener);
    }
    if ("aborted" in chunk) {
      await reader.cancel(signal.reason).catch(() => undefined);
      throw signal.reason instanceof Error ? signal.reason : new Error("Body read was aborted");
    }
    if ("deadline" in chunk) {
      await reader.cancel(new BodyReadDeadlineError()).catch(() => undefined);
      throw new BodyReadDeadlineError();
    }
    const { result } = chunk;
    if (result.done) break;
    length += result.value.byteLength;
    if (length > limit) {
      await reader.cancel(new Error("Body exceeded OpenWork anonymous inference limit")).catch(() => undefined);
      return null;
    }
    chunks.push(result.value);
  }
  const body: Uint8Array<ArrayBuffer> = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function boundedStreamResponse(
  response: Response,
  controller: AbortController,
  cleanup: () => void,
): Response {
  if (!response.body) {
    cleanup();
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: forwardedHeaders(response.headers),
    });
  }
  const reader = response.body.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    controller.signal.removeEventListener("abort", abortUpstream);
    cleanup();
  };
  const abortUpstream = () => {
    void reader.cancel(controller.signal.reason).catch(() => undefined);
    finish();
  };
  controller.signal.addEventListener("abort", abortUpstream, { once: true });
  const body = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          streamController.close();
          return;
        }
        streamController.enqueue(chunk.value);
      } catch (error) {
        finish();
        streamController.error(error);
      }
    },
    async cancel(reason) {
      controller.abort(reason);
      finish();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: forwardedHeaders(response.headers),
  });
}

function failureCacheDuration(headers: Headers): number {
  const retryAfter = headers.get("retry-after")?.trim();
  if (!retryAfter) return REMOTE_FAILURE_CACHE_DEFAULT_MS;
  const seconds = Number(retryAfter);
  const duration = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(retryAfter) - Date.now();
  if (!Number.isFinite(duration) || duration <= 0) return REMOTE_FAILURE_CACHE_DEFAULT_MS;
  return Math.max(REMOTE_FAILURE_CACHE_DEFAULT_MS, Math.min(duration, REMOTE_FAILURE_CACHE_MAX_MS));
}

export class AnonymousInferenceService {
  private readonly origin: string;
  private readonly localAccessToken = `${LOCAL_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  private readonly installationPath: string;
  private installationIdPromise: Promise<string> | null = null;
  private session: AnonymousSession | null = null;
  private sessionPromise: Promise<AnonymousSession> | null = null;
  private activeControllers = new Set<AbortController>();
  private failures = new Map<string, CachedFailure>();
  private readonly eligible: boolean;
  private cloudSessionActive = false;
  private available = false;
  private stopped = false;

  constructor(
    private readonly config: ServerConfig,
    private readonly logger: AnonymousInferenceLogger,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.origin = resolveAnonymousInferenceOrigin(environment);
    this.installationPath = join(runtimeStorageDir(config), "anonymous-inference-installation.json");
    this.eligible = config.anonymousInferenceEligible === true
      && !config.readOnly
      && !anonymousInferenceDisabled(environment);
    this.available = this.eligible;
  }

  async initialize(boundPort: number): Promise<boolean> {
    if (this.stopped) return false;
    if (this.config.readOnly) {
      this.available = false;
      return false;
    }
    const runtime = await readGlobalRuntimeOpencodeConfig(this.config);
    const providers = runtimeProviderMap(runtime);
    const current = providers[ANONYMOUS_INFERENCE_PROVIDER_ID];
    const permitted = this.eligible
      && !this.cloudSessionActive
      && runtime.managedPolicy?.allowCustomProviders !== false
      && !runtimeDisabledProviderList(runtime).includes(ANONYMOUS_INFERENCE_PROVIDER_ID);

    if (!permitted) {
      this.disable();
      if (current && isOwnedProvider(current)) {
        await writeGlobalRuntimeOpencodeConfig(this.config, (snapshot) => ({
          ...snapshot,
          provider: mergeRuntimeProviderUpdate(snapshot.provider, { [ANONYMOUS_INFERENCE_PROVIDER_ID]: null }),
        }));
      }
      return false;
    }

    if (current && !isOwnedProvider(current)) {
      this.disable();
      this.logger.log("warn", "Reserved anonymous inference provider id is already user-configured; leaving it unchanged.", {
        provider_id: ANONYMOUS_INFERENCE_PROVIDER_ID,
      });
      return false;
    }

    this.available = true;

    const provider = {
      name: ANONYMOUS_INFERENCE_PROVIDER_NAME,
      npm: "@openrouter/ai-sdk-provider",
      options: {
        apiKey: this.localAccessToken,
        baseURL: `http://127.0.0.1:${boundPort}${LOCAL_ROUTE_PREFIX}`,
      },
      models: {
        [ANONYMOUS_INFERENCE_MODEL_ID]: {
          id: ANONYMOUS_INFERENCE_MODEL_ID,
          name: "GPT-5.6 Luna",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          options: { reasoningEffort: "none" },
          limit: { context: 135_168, input: 131_072, output: 4_096 },
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    };
    await writeGlobalRuntimeOpencodeConfig(this.config, (snapshot) => ({
      ...snapshot,
      provider: mergeRuntimeProviderUpdate(snapshot.provider, { [ANONYMOUS_INFERENCE_PROVIDER_ID]: provider }),
    }));
    return true;
  }

  async setCloudSessionActive(active: boolean, boundPort: number): Promise<boolean> {
    this.cloudSessionActive = active;
    return await this.initialize(boundPort);
  }

  async handle(request: Request, endpoint: "models" | "chat/completions"): Promise<Response> {
    request.signal.throwIfAborted();
    if (!this.available || this.stopped) {
      return jsonError(503, "anonymous_unavailable", "OpenWork Models (Free) are unavailable for this installation.");
    }
    if (!this.authenticates(request)) {
      return jsonError(401, "invalid_local_anonymous_token", "The local OpenWork Models credential is invalid.");
    }
    if (endpoint === "models") {
      if (request.method !== "GET") {
        return jsonError(405, "method_not_allowed", "This OpenWork Models route requires GET.", { allow: "GET" });
      }
      return Response.json({
        object: "list",
        data: [{ id: ANONYMOUS_INFERENCE_MODEL_ID, object: "model", owned_by: "openwork" }],
      });
    }
    if (endpoint === "chat/completions" && request.method !== "POST") {
      return jsonError(405, "method_not_allowed", "This OpenWork Models route requires POST.", { allow: "POST" });
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > REQUEST_BODY_LIMIT_BYTES) {
      await request.body?.cancel(new Error("Anonymous inference request was too large")).catch(() => undefined);
      return jsonError(413, "anonymous_request_too_large", "The OpenWork Models request is too large.");
    }
    const deadlineAt = Date.now() + REQUEST_LIFETIME_MS;
    let boundedBody: Uint8Array<ArrayBuffer> | null;
    try {
      boundedBody = await readBoundedBody(
        request.body,
        REQUEST_BODY_LIMIT_BYTES,
        request.signal,
        Math.min(deadlineAt, Date.now() + REQUEST_BODY_TIMEOUT_MS),
      );
    } catch (error) {
      if (request.signal.aborted) throw error;
      return jsonError(503, "anonymous_unavailable", "OpenWork Models could not read the request in time. Try again.");
    }
    if (!boundedBody) {
      return jsonError(413, "anonymous_request_too_large", "The OpenWork Models request is too large.");
    }
    const body = request.method === "GET" ? undefined : boundedBody.buffer;
    const requestKey = createHash("sha256")
      .update(endpoint)
      .update("\0")
      .update(body ? new Uint8Array(body) : new Uint8Array())
      .digest("hex");
    const cached = this.cachedFailure(requestKey);
    if (cached) return responseFromCachedFailure(cached);

    try {
      return await this.proxy(request, endpoint, body, requestKey, true, false, deadlineAt);
    } catch (error) {
      if (request.signal.aborted) throw error;
      this.logger.log("warn", "Anonymous inference request failed before a response began.", {
        error: error instanceof Error ? error.message : "anonymous_inference_request_failed",
      });
      return jsonError(503, "anonymous_unavailable", "OpenWork Models (Free) are temporarily unavailable. Try again later or use your own provider.");
    }
  }

  stop(): void {
    this.stopped = true;
    this.disable();
    this.failures.clear();
    this.session = null;
  }

  private disable(): void {
    this.available = false;
    for (const controller of this.activeControllers) controller.abort(new Error("OpenWork anonymous inference was disabled"));
    this.activeControllers.clear();
  }

  private async assertDispatchAllowed(request: Request, signal: AbortSignal): Promise<void> {
    request.signal.throwIfAborted();
    signal.throwIfAborted();
    if (this.stopped || !this.available) throw new Error("OpenWork anonymous inference is unavailable");
    const runtime = await readGlobalRuntimeOpencodeConfig(this.config);
    request.signal.throwIfAborted();
    signal.throwIfAborted();
    if (this.cloudSessionActive
      || runtime.managedPolicy?.allowCustomProviders === false
      || runtimeDisabledProviderList(runtime).includes(ANONYMOUS_INFERENCE_PROVIDER_ID)) {
      this.disable();
      throw new Error("OpenWork anonymous inference is disabled by local policy");
    }
  }

  private authenticates(request: Request): boolean {
    const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!supplied) return false;
    const actual = Buffer.from(supplied);
    const expected = Buffer.from(this.localAccessToken);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private async installationId(): Promise<string> {
    this.installationIdPromise ??= this.loadOrCreateInstallationId();
    return await this.installationIdPromise;
  }

  private async loadOrCreateInstallationId(): Promise<string> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.installationPath, "utf8"));
      if (isRecord(parsed) && typeof parsed.installationId === "string" && isUuid(parsed.installationId)) {
        return parsed.installationId;
      }
    } catch {
      // A missing or invalid file is repaired with a new stable installation id.
    }
    const installationId = randomUUID();
    await mkdir(dirname(this.installationPath), { recursive: true });
    const temporaryPath = `${this.installationPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ installationId })}\n`, { flag: "wx", mode: 0o600 });
    try {
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.installationPath);
      await chmod(this.installationPath, 0o600);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return installationId;
  }

  private async guestSession(force = false): Promise<AnonymousSession> {
    if (!force && this.session && this.session.expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now()) return this.session;
    if (this.sessionPromise) return await this.sessionPromise;
    const mint = this.mintGuestSession();
    this.sessionPromise = mint;
    try {
      this.session = await mint;
      return this.session;
    } finally {
      if (this.sessionPromise === mint) this.sessionPromise = null;
    }
  }

  private async mintGuestSession(): Promise<AnonymousSession> {
    const response = await externalFetch(`${this.origin}/api/anonymous/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationId: await this.installationId() }),
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Anonymous session request was rejected (${response.status})`);
    const payload: unknown = await response.json();
    if (
      !isRecord(payload)
      || typeof payload.token !== "string"
      || !payload.token.trim()
      || typeof payload.expiresAt !== "number"
      || !Number.isFinite(payload.expiresAt)
      || payload.expiresAt <= Date.now()
      || payload.model !== ANONYMOUS_INFERENCE_MODEL_ID
    ) {
      throw new Error("Anonymous session response was invalid");
    }
    return { token: payload.token, expiresAt: payload.expiresAt };
  }

  private async proxy(
    request: Request,
    endpoint: "models" | "chat/completions",
    body: ArrayBuffer | undefined,
    requestKey: string,
    allowAuthRetry: boolean,
    forceSessionRefresh: boolean,
    deadlineAt: number,
  ): Promise<Response> {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const abortFromCaller = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) controller.abort(request.signal.reason);
    else request.signal.addEventListener("abort", abortFromCaller, { once: true });
    const lifetimeTimeout = setTimeout(
      () => controller.abort(new Error("Anonymous inference request lifetime expired")),
      Math.max(1, deadlineAt - Date.now()),
    );
    let headerTimeout: ReturnType<typeof setTimeout> | undefined;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(lifetimeTimeout);
      if (headerTimeout) clearTimeout(headerTimeout);
      request.signal.removeEventListener("abort", abortFromCaller);
      this.activeControllers.delete(controller);
    };

    let session: AnonymousSession;
    try {
      await this.assertDispatchAllowed(request, controller.signal);
      session = await this.guestSession(forceSessionRefresh);
      await this.assertDispatchAllowed(request, controller.signal);
    } catch (error) {
      cleanup();
      throw error;
    }

    let response: Response;
    try {
      await this.assertDispatchAllowed(request, controller.signal);
      headerTimeout = setTimeout(
        () => controller.abort(new Error("Anonymous inference response headers timed out")),
        Math.min(RESPONSE_HEADER_TIMEOUT_MS, Math.max(1, deadlineAt - Date.now())),
      );
      response = await externalFetch(`${this.origin}/api/anonymous/v1/${endpoint}`, {
        method: request.method,
        headers: {
          authorization: `Bearer ${session.token}`,
          ...(body ? { "content-type": request.headers.get("content-type") ?? "application/json" } : {}),
          ...(request.headers.get("accept") ? { accept: request.headers.get("accept") ?? "*/*" } : {}),
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(headerTimeout);
      headerTimeout = undefined;
    } catch (error) {
      cleanup();
      throw error;
    }

    if (!response.ok) {
      const declaredErrorLength = Number(response.headers.get("content-length") ?? "0");
      let bytes: Uint8Array<ArrayBuffer> | null = null;
      try {
        if (Number.isFinite(declaredErrorLength) && declaredErrorLength > ERROR_BODY_LIMIT_BYTES) {
          await response.body?.cancel(new Error("Anonymous inference error body was too large")).catch(() => undefined);
        } else {
          bytes = await readBoundedBody(response.body, ERROR_BODY_LIMIT_BYTES, controller.signal, deadlineAt);
        }
      } finally {
        cleanup();
      }
      if (!bytes) {
        return jsonError(503, "anonymous_unavailable", "OpenWork Models (Free) returned an invalid error response.");
      }
      const code = errorCode(bytes);
      if (allowAuthRetry && response.status === 401 && code === "invalid_anonymous_token") {
        const rejectedCurrentSession = this.session?.token === session.token;
        if (rejectedCurrentSession) this.session = null;
        request.signal.throwIfAborted();
        if (this.stopped || !this.available) {
          return jsonError(503, "anonymous_unavailable", "OpenWork Models (Free) are unavailable for this installation.");
        }
        return await this.proxy(request, endpoint, body, requestKey, false, rejectedCurrentSession, deadlineAt);
      }
      const failure: CachedFailure = {
        expiresAt: Date.now() + failureCacheDuration(response.headers),
        status: response.status,
        statusText: response.statusText,
        headers: forwardedHeaders(response.headers),
        body: bytes,
      };
      if (["anonymous_limit_exceeded", "anonymous_capacity_exceeded", "anonymous_unavailable"].includes(code ?? "")) {
        failure.headers.push(["x-openwork-anonymous-no-upstream-retry", "1"]);
        this.rememberFailure(requestKey, failure);
      }
      return responseFromCachedFailure(failure);
    }
    return boundedStreamResponse(response, controller, cleanup);
  }

  private cachedFailure(key: string): CachedFailure | null {
    const now = Date.now();
    for (const [candidate, failure] of this.failures) {
      if (failure.expiresAt <= now) this.failures.delete(candidate);
    }
    return this.failures.get(key) ?? null;
  }

  private rememberFailure(key: string, failure: CachedFailure): void {
    if (this.failures.size >= MAX_REMOTE_FAILURE_CACHE_ENTRIES) {
      const oldest = this.failures.keys().next().value;
      if (oldest) this.failures.delete(oldest);
    }
    this.failures.set(key, failure);
  }
}
