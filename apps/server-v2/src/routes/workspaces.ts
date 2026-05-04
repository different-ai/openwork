import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { HTTPException } from "hono/http-exception";
import { getRequestContext, type AppBindings } from "../context/request-context.js";
import { buildSuccessResponse } from "../http.js";
import { jsonResponse, withCommonErrorResponses } from "../openapi.js";
import { workspaceDetailResponseSchema, workspaceListResponseSchema } from "../schemas/registry.js";
import { routePaths } from "./route-paths.js";

function readIncludeHidden(url: string) {
  const value = new URL(url).searchParams.get("includeHidden")?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function registerWorkspaceRoutes(app: Hono<AppBindings>) {
  app.get(
    routePaths.workspaces.base,
    describeRoute({
      tags: ["Workspaces"],
      summary: "List workspaces",
      description: "Returns the canonical workspace inventory from the server-owned registry. Hidden control/help workspaces are excluded unless the caller asks for them with host scope.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace inventory returned successfully.", workspaceListResponseSchema),
      }, { includeForbidden: true, includeUnauthorized: true }),
    }),
    (c) => {
      const requestContext = getRequestContext(c);
      requestContext.services.auth.requireVisibleRead(requestContext.actor);

      const includeHidden = readIncludeHidden(c.req.url);
      if (includeHidden) {
        requestContext.services.auth.requireHost(requestContext.actor);
      }

      return c.json(
        buildSuccessResponse(
          requestContext.requestId,
          requestContext.services.system.listWorkspaces({ includeHidden }),
        ),
      );
    },
  );

  app.get(
    routePaths.workspaces.byId(),
    describeRoute({
      tags: ["Workspaces"],
      summary: "Get workspace detail",
      description: "Returns the canonical workspace detail shape for a single workspace, including backend resolution and runtime summary fields.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace detail returned successfully.", workspaceDetailResponseSchema),
      }, { includeNotFound: true, includeUnauthorized: true }),
    }),
    (c) => {
      const requestContext = getRequestContext(c);
      requestContext.services.auth.requireVisibleRead(requestContext.actor);
      const workspaceId = c.req.param("workspaceId") ?? "";

      const workspace = requestContext.services.system.getWorkspace(
        workspaceId,
        { includeHidden: requestContext.actor.kind === "host" },
      );

      if (!workspace) {
        throw new HTTPException(404, {
          message: `Workspace not found: ${workspaceId}`,
        });
      }

      return c.json(buildSuccessResponse(requestContext.requestId, workspace));
    },
  );
}
