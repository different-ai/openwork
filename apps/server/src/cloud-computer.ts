import { randomBytes } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createCloudComputer, type CloudComputer } from "@openwork/computer-use/cloud";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";
import { touchCloudComputerActivity } from "./cloud-computer-activity.js";
import { serve } from "./serve-node.js";
import { ApiError } from "./errors.js";
import type { ServerConfig } from "./types.js";

const computers = new WeakMap<ServerConfig, CloudComputer>();
export function cloudComputerJson(value: unknown): Response {
  return Response.json(value, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
export function cloudComputerFor(config: ServerConfig): CloudComputer {
  const computer = computers.get(config);
  if (!computer) throw new ApiError(404, "computer_unavailable", "This workspace has no cloud computer. Ask your administrator to finish setup.");
  return computer;
}

export async function startCloudComputerBridge(config: ServerConfig): Promise<() => Promise<void>> {
  const discovery = process.env.OPENWORK_UI_CONTROL_DISCOVERY;
  const display = process.env.OPENWORK_CLOUD_COMPUTER_DISPLAY;
  // These describe the operator-installed runtime, never grant feature access.
  if (process.platform !== "linux" || process.env.DEN_RUNTIME_MANAGED !== "1" || !display || !discovery) return async () => {};
  const computer = await createCloudComputer({ directory: join(dirname(discovery), "computer"), display,
    enabled: () => managedDesktopPolicy(config).remoteComputersEnabled(),
    secretsEnabled: () => managedDesktopPolicy(config).browserSecretHandlesEnabled(),
    onActivity: touchCloudComputerActivity });
  computers.set(config, computer);
  const token = randomBytes(32).toString("base64url");
  const bridge = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/browser/task", "/computer/task", "/computer/program"].includes(path)) return new Response(null, { status: 404 });
    try {
      const text = await request.text();
      if (text.length > 64_000) return new Response(null, { status: 413 });
      const body: unknown = JSON.parse(text);
      if (!body || typeof body !== "object" || Array.isArray(body)) return new Response(null, { status: 400 });
      return cloudComputerJson(await computer.task(path, Object.fromEntries(Object.entries(body)), request.signal));
    } catch (error) {
      return Response.json({ ok: false, code: "computer_interrupted", retrySafe: false,
        error: error instanceof Error ? error.message : "Computer operation did not finish. Observe before retrying." });
    }
  } });
  try {
    await mkdir(dirname(discovery), { recursive: true, mode: 0o700 });
    await writeFile(discovery, JSON.stringify({ baseUrl: `http://127.0.0.1:${bridge.port}`, token }), { mode: 0o600 });
  } catch (error) { await bridge.stop(); await computer.close(); computers.delete(config); throw error; }
  return async () => { computers.delete(config); await bridge.stop(); await computer.close(); await rm(discovery, { force: true }); };
}

/** Translate protocol failures without turning a disabled rollout into a server error. */
export async function cloudComputerCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "computer_unavailable";
    const status = code === "feature_disabled" ? 403 : ["busy", "paused", "view_changed", "frame_changed"].includes(code) ? 409 : code.startsWith("invalid_") ? 400 : 503;
    throw new ApiError(status, code, error instanceof Error ? error.message : "Reconnect the cloud computer.");
  }
}

// Secret handles for the cloud browser. A request body on these routes can hold a secret's value, so nothing here
// logs, stores or repeats a body, and every error message is written here, never built from what was sent.
const SECRETS_UNAVAILABLE = "Secrets for the cloud browser are not available for this organization.";
/** A 4096-character value at six bytes a character (escaped, or as UTF-8), a name and ten website addresses. */
const SECRET_BODY_BYTES = 64 * 1024;

/** The computer behind the secret routes; a workspace without one answers exactly as one with the rollout off. */
export function cloudComputerSecretsFor(config: ServerConfig): CloudComputer {
  const computer = computers.get(config);
  if (!computer) throw new ApiError(404, "feature_disabled", SECRETS_UNAVAILABLE);
  return computer;
}

/** The secret routes answer 404 `feature_disabled` unless the cloud computer and the secret handles rollout are both on. */
export async function cloudComputerSecretsCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "feature_disabled") throw new ApiError(404, "feature_disabled", SECRETS_UNAVAILABLE);
    throw new ApiError(503, "computer_unavailable", "The cloud computer did not answer. Try again.");
  }
}

/** Reads one bounded JSON object. A parser's own message quotes the text it could not read, so it is never passed on. */
export async function readCloudComputerSecretBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new ApiError(415, "invalid_content_type", "A JSON request is required");
  const tooLarge = () => new ApiError(413, "request_too_large", "That request is too large.");
  if (Number(request.headers.get("content-length")) > SECRET_BODY_BYTES) throw tooLarge();
  const chunks: Uint8Array[] = [];
  const reader = request.body?.getReader();
  for (let size = 0; reader;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > SECRET_BODY_BYTES) { void reader.cancel().catch(() => undefined); throw tooLarge(); }
    chunks.push(value);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ApiError(400, "invalid_json", "Invalid JSON body"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "invalid_payload", "A JSON object is required");
  return Object.fromEntries(Object.entries(parsed));
}

/** The conversation a secret request names. */
export function cloudComputerSecretSession(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256) throw new ApiError(400, "invalid_session", "A conversation is required.");
  return value;
}

/** What the person entered for a new secret, checked for shape only; the computer checks and explains the rest. */
export function cloudComputerSecretInput(body: Record<string, unknown>): Parameters<CloudComputer["secrets"]["add"]>[0] {
  const { label, kind, origins, value } = body;
  const sessionId = cloudComputerSecretSession(body.sessionId);
  if (typeof label !== "string" || typeof value !== "string" || (kind !== "password" && kind !== "code" && kind !== "token")
    || !Array.isArray(origins) || !origins.every((origin): origin is string => typeof origin === "string")) {
    throw new ApiError(400, "invalid_payload", "Provide a name, a kind, the websites and the secret.");
  }
  return { sessionId, label, kind, origins, value };
}
