import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { serve } from "./serve-node.js";
import { localSandboxRuntime, type createLocalSandboxRuntime } from "./local-sandbox-runtime.js";
import type { ServerConfig } from "./types.js";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";

import { createComputerService } from "./computers/service.js";
import { computersSandboxConflict } from "./computers/tool-names.js";
import { computerApprovalUnavailable } from "./computers/messages.js";

const requestSchema = z.object({
  operation: z.enum(["status", "prompt", "execute", "host", "computers-status", "computer-binding", "computer-select", "computer-permissions", "computer-execute"]), directory: z.string().min(1).max(4096),
  name: z.string().min(1).max(80).optional(), input: z.unknown().optional(), bindingId: z.string().min(1).max(256).optional(),
  sessionId: z.string().min(1).max(256).optional(), callId: z.string().min(1).max(256).optional(),
}).strict();

export async function createSandboxToolsBridge(
  config: ServerConfig,
  runtime: ReturnType<typeof createLocalSandboxRuntime> = localSandboxRuntime(config),
  computers = createComputerService(config, managedDesktopPolicy(config).computersDen),
) {
  const token = randomBytes(32).toString("base64url");
  const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const supplied = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return new Response(null, { status: 401 });
    if (request.headers.has("origin")) return new Response(null, { status: 403 });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/sandbox") return new Response(null, { status: 404 });
    try {
      const text = await request.text();
      if (Buffer.byteLength(text) > 256_000) return new Response(null, { status: 413 });
      const call = requestSchema.parse(JSON.parse(text));
      if (call.operation === "status") return Response.json(await runtime.status(call.directory));
      if (call.operation === "prompt") {
        void runtime.prepare(call.directory, "prompt");
        return Response.json({ accepted: true });
      }
      if (call.operation === "host") {
        await managedDesktopPolicy(config).assertHostExecution();
        return Response.json({ allowed: true });
      }
      if (call.operation === "computers-status") return Response.json(await computers.status());
      if (call.operation === "computer-binding" || call.operation === "computer-select" || call.operation === "computer-permissions" || call.operation === "computer-execute") {
        if (!call.sessionId) return new Response(null, { status: 400 });
        if (call.operation === "computer-select") {
          if ((await runtime.status(call.directory)).mode !== "off") throw new Error(computersSandboxConflict);
          const { computer } = z.strictObject({ computer: z.string().max(256).optional() }).parse(call.input);
          return Response.json({ text: await computers.select(call.directory, call.sessionId, computer) });
        }
        if (call.operation === "computer-binding") return Response.json({ binding: await computers.binding(call.directory, call.sessionId) });
        if (!call.name) return new Response(null, { status: 400 });
        if (call.operation === "computer-permissions") {
          const binding = await computers.binding(call.directory, call.sessionId);
          if (!binding) return Response.json({ approval: null });
          if ((await runtime.status(call.directory)).mode !== "off") throw new Error(computersSandboxConflict);
          return Response.json({ approval: computers.permissions(binding, call.name, call.input) }, { headers: { "Cache-Control": "no-store" } });
        }
        if (!call.bindingId) throw new Error(computerApprovalUnavailable);
        if ((await runtime.status(call.directory)).mode !== "off") throw new Error(computersSandboxConflict);
        const result = await computers.execute(call.directory, call.sessionId, call.bindingId, call.name, call.input, request.signal);
        return Response.json({ result }, { headers: { "Cache-Control": "no-store" } });
      }
      if (!call.name || !call.sessionId) return new Response(null, { status: 400 });
      const result = await runtime.execute(call.directory, call.name, call.input, {
        sessionID: call.sessionId, signal: request.signal, ...(call.callId ? { id: call.callId } : {}),
      });
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "The sandbox couldn't complete this operation." }, { status: 503 });
    }
  } });
  return { url: `http://127.0.0.1:${server.port}/sandbox`, token, close: () => server.stop() };
}
