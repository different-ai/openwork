import type { Context } from "hono";
import type { AppBindings } from "../context/request-context.js";
import { getOtelApi } from "./api.js";

export type GenAiOperation =
  | "chat"
  | "command"
  | "summarize"
  | "shell"
  | "init"
  | "fork"
  | "abort"
  | "share"
  | "revert"
  | "unrevert";

export async function recordPromptAttributes(
  c: Context<AppBindings>,
  ctx: {
    operation: GenAiOperation;
    workspaceId: string;
    sessionId: string;
    body?: Record<string, unknown> | undefined;
  },
): Promise<void> {
  const api = await getOtelApi();
  if (!api) return;

  const span = api.trace.getActiveSpan();
  if (!span) return;

  span.setAttribute("gen_ai.operation.name", ctx.operation);
  span.setAttribute("openwork.workspace_id", ctx.workspaceId);
  span.setAttribute("openwork.session_id", ctx.sessionId);

  const body = ctx.body ?? {};
  const inner = body.model;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const provider = readString((inner as Record<string, unknown>).providerID);
    const model = readString((inner as Record<string, unknown>).modelID);
    if (provider) span.setAttribute("gen_ai.system", provider);
    if (model) span.setAttribute("gen_ai.request.model", model);
  } else if (typeof inner === "string") {
    span.setAttribute("gen_ai.request.model", inner);
  }

  const agent = readString(body.agent);
  if (agent) span.setAttribute("openwork.agent.name", agent);

  const reasoning = readString(body.reasoning_effort);
  if (reasoning) span.setAttribute("gen_ai.request.reasoning_effort", reasoning);

  const command = readString(body.command);
  if (command) span.setAttribute("openwork.command", command);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}
