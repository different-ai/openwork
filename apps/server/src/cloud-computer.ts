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
    enabled: () => managedDesktopPolicy(config).remoteComputersEnabled(), onActivity: touchCloudComputerActivity });
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
