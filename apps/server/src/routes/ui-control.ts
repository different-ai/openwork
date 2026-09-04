import { ApiError } from "../errors.js";
import type { UiControlKind } from "../types.js";
import { addRoute, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

interface RegisterUiControlRoutesOptions {
  routes: Route[];
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
}

function isUiControlKind(value: unknown): value is UiControlKind {
  return value === "context" || value === "query" || value === "command";
}

export function registerUiControlRoutes(options: RegisterUiControlRoutesOptions): void {
  const { routes, jsonResponse, readJsonBody } = options;

  addRoute(routes, "POST", "/experimental/ui-control/request", "client", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    if (!isUiControlKind(body.kind)) {
      throw new ApiError(
        400,
        "invalid_ui_control_request",
        "UI control request kind must be context, query, or command",
      );
    }
    const result = await ctx.uiControl.request(body.kind, body.input);
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/experimental/ui-control/pending", "client", async (ctx) => {
    const items = await ctx.uiControl.pending({ wait: ctx.url.searchParams.get("wait") === "1", signal: ctx.request.signal });
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/experimental/ui-control/:id/reply", "client", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    if (!ctx.uiControl.reply(ctx.params.id, body.result)) {
      throw new ApiError(404, "ui_control_request_not_found", "UI control request not found");
    }
    return jsonResponse({ ok: true });
  });
}
