import { z } from "zod";

import { ApiError } from "../errors.js";
import {
  CodeSessionsError,
  type CodeSessionClient,
} from "../code-sessions/types.js";
import { createCodeSessionsService, type CodeSessionsService } from "../code-sessions/index.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";
import type { TokenScope } from "../types.js";

const clientToggleSchema = z.object({ enabled: z.boolean() }).strict();

function statusOf(error: CodeSessionsError): number {
  if (error.code === "code_session_not_found") return 404;
  if (error.code === "code_session_client_disabled") return 409;
  return 400;
}

interface RegisterCodeSessionsRoutesOptions {
  routes: Route[];
  jsonResponse: (data: unknown, status?: number) => Response;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  /** Injectable for tests; defaults to the shared in-memory service. */
  service?: CodeSessionsService;
}

/**
 * The Code tab's machine-wide session mirror.
 *
 * - GET /code-sessions lists every stored session of every enabled coding
 *   agent on this computer, with per-client toggle state.
 * - GET /code-sessions/:client/:folder/:file returns one session's transcript.
 * - PUT /code-sessions/clients/:client turns a client's mirror on or off.
 *
 * Client-scoped auth like the Claude Code import routes: the desktop owner
 * and the headless-web owner both hold a collaborator client token, and the
 * browser bundle deliberately never receives the host token. Nothing here
 * writes to the clients' data.
 */
export function registerCodeSessionsRoutes(options: RegisterCodeSessionsRoutesOptions): void {
  const { routes, jsonResponse, requireClientScope } = options;
  const service = options.service ?? createCodeSessionsService();

  const toApiError = (error: unknown): unknown => {
    if (error instanceof CodeSessionsError) {
      return new ApiError(statusOf(error), error.code, error.message);
    }
    return error;
  };

  const parseClient = (value: string): CodeSessionClient => {
    if (value === "claude-code" || value === "codex" || value === "pi" || value === "opencode") return value;
    throw new ApiError(400, "code_session_client_unknown", "This coding agent is not supported yet.");
  };

  addRoute(routes, "GET", "/code-sessions", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const items = await service.list();
    return jsonResponse({ clients: service.clients(), items });
  });

  addRoute(routes, "GET", "/code-sessions/:client/:folder/:file", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const client = parseClient(ctx.params.client);
    try {
      return jsonResponse({ item: await service.read(client, `${ctx.params.folder}/${ctx.params.file}`) });
    } catch (error) {
      throw toApiError(error);
    }
  });

  addRoute(routes, "PUT", "/code-sessions/clients/:client", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const client = parseClient(ctx.params.client);
    let body: unknown;
    try {
      body = await ctx.request.json();
    } catch {
      throw new ApiError(400, "invalid_payload", "Send a JSON body.");
    }
    const parsed = clientToggleSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "invalid_payload", "Send { enabled: true | false }.");
    }
    try {
      service.setClientEnabled(client, parsed.data.enabled);
    } catch (error) {
      throw toApiError(error);
    }
    return jsonResponse({ clients: service.clients() });
  });
}
