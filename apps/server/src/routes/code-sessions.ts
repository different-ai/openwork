import { z } from "zod";

import { ApiError } from "../errors.js";
import { claudeDriveContext } from "../code-sessions/claude-code.js";
import { claudeConfigDir } from "../claude-import.js";
import { opencodeDriveContext } from "../code-sessions/opencode.js";
import { opencodeRunSpec } from "../code-sessions/drive.js";
import {
  CodeSessionsError,
  type CodeSessionClient,
} from "../code-sessions/types.js";
import { createCodeSessionsService, type CodeSessionsService } from "../code-sessions/index.js";
import { createDriveRegistry, type DriveRegistry } from "../code-sessions/drive.js";
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
  /** Injectable for tests; defaults to the shared drive registry. */
  drives?: DriveRegistry;
  /** Claude's data folder resolver, for drive context lookups. */
  claudeConfigDir?: () => string;
  /** OpenCode's database path resolver, for drive context lookups. */
  opencodeDbPath?: () => string;
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

  // Clients whose session ids are a single opaque token (OpenCode's ses_…)
  // read through the flat route; path-scoped clients keep the three-segment
  // one above.
  addRoute(routes, "GET", "/code-sessions/:client/:id", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const client = parseClient(ctx.params.client);
    try {
      return jsonResponse({ item: await service.read(client, ctx.params.id) });
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

  const drives = options.drives ?? createDriveRegistry();
  const driveSchema = z.object({
    client: z.enum(["claude-code", "opencode"]),
    sessionId: z.string().min(1).max(400),
    prompt: z.string().min(1).max(100_000),
  }).strict();

  const toPublicDrives = () => ({ runs: drives.list() });

  // Driven mode: run one prompt headlessly against a stored session. The
  // agent appends to its own transcript, so the mirror's next poll shows the
  // turn while it runs. Claude Code resumes via its CLI; OpenCode continues
  // via `opencode run --session`. Codex (app-server) joins through the same
  // route once its driver lands.
  addRoute(routes, "POST", "/code-sessions/drives", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    let body: unknown;
    try {
      body = await ctx.request.json();
    } catch {
      throw new ApiError(400, "invalid_payload", "Send a JSON body.");
    }
    const parsed = driveSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "invalid_payload", "Send { client, sessionId, prompt }.");
    }
    try {
      if (parsed.data.client === "claude-code") {
        const context = await claudeDriveContext(parsed.data.sessionId, { configDir: options.claudeConfigDir?.() ?? claudeConfigDir() });
        return jsonResponse({
          run: drives.start({
            client: parsed.data.client,
            sessionId: parsed.data.sessionId,
            prompt: parsed.data.prompt,
            cwd: context.cwd,
            uuid: context.uuid,
          }),
        }, 202);
      }
      const context = await opencodeDriveContext(parsed.data.sessionId, { dbPath: options.opencodeDbPath?.() });
      return jsonResponse({
        run: drives.start({
          client: parsed.data.client,
          sessionId: parsed.data.sessionId,
          prompt: parsed.data.prompt,
          cwd: context.directory,
        }, opencodeRunSpec({
          client: parsed.data.client,
          sessionId: parsed.data.sessionId,
          prompt: parsed.data.prompt,
          cwd: context.directory,
        })),
      }, 202);
    } catch (error) {
      throw toApiError(error);
    }
  });

  addRoute(routes, "GET", "/code-sessions/drives", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    return jsonResponse(toPublicDrives());
  });

  addRoute(routes, "POST", "/code-sessions/drives/:id/abort", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    try {
      return jsonResponse({ run: drives.abort(ctx.params.id) });
    } catch (error) {
      throw toApiError(error);
    }
  });
}
