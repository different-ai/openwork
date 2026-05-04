import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { getRequestContext, type AppBindings } from "../context/request-context.js";
import { buildSuccessResponse } from "../http.js";
import { jsonResponse, withCommonErrorResponses } from "../openapi.js";
import {
  opencodeHealthResponseSchema,
  routerHealthResponseSchema,
  runtimeSummaryResponseSchema,
  runtimeUpgradeResponseSchema,
  runtimeVersionsResponseSchema,
} from "../schemas/runtime.js";
import { routePaths } from "./route-paths.js";

export function registerRuntimeRoutes(app: Hono<AppBindings>) {
  app.get(
    routePaths.system.opencodeHealth,
    describeRoute({
      tags: ["Runtime"],
      summary: "Get OpenCode health",
      description: "Returns the server-owned OpenCode runtime health, version, URL, and recent diagnostics.",
      responses: withCommonErrorResponses({
        200: jsonResponse("OpenCode runtime health returned successfully.", opencodeHealthResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    (c) => {
      const requestContext = getRequestContext(c);
      requestContext.services.auth.requireVisibleRead(requestContext.actor);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.runtime.getOpencodeHealth()));
    },
  );

  app.get(
    routePaths.system.routerHealth,
    describeRoute({
      tags: ["Runtime"],
      summary: "Get router health",
      description: "Returns the server-owned opencode-router health, enablement decision, and recent diagnostics.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Router runtime health returned successfully.", routerHealthResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    (c) => {
      const requestContext = getRequestContext(c);
      requestContext.services.auth.requireVisibleRead(requestContext.actor);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.runtime.getRouterHealth()));
    },
  );

  app.get(
    routePaths.system.runtime.summary,
    describeRoute({
      tags: ["Runtime"],
      summary: "Get runtime summary",
      description: "Returns the current runtime supervision summary, manifest, restart policy, and child process state.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Runtime summary returned successfully.", runtimeSummaryResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    (c) => {
      const requestContext = getRequestContext(c);
      requestContext.services.auth.requireVisibleRead(requestContext.actor);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.runtime.getRuntimeSummary()));
    },
  );

  app.get(
    routePaths.system.runtime.versions,
    describeRoute({
      tags: ["Runtime"],
      summary: "Get runtime versions",
      description: "Returns the active and pinned runtime versions that Server V2 resolved for OpenCode and opencode-router.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Runtime versions returned successfully.", runtimeVersionsResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    (c) => {
      const requestContext = getRequestContext(c);
      requestContext.services.auth.requireVisibleRead(requestContext.actor);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.runtime.getRuntimeVersions()));
    },
  );

  app.post(
    routePaths.system.runtime.upgrade,
    describeRoute({
      tags: ["Runtime"],
      summary: "Upgrade runtime assets",
      description: "Re-resolves the pinned runtime bundle through Server V2, restarts managed children, and returns the resulting runtime summary plus upgrade state.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Runtime upgraded successfully.", runtimeUpgradeResponseSchema),
      }, { includeForbidden: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const requestContext = getRequestContext(c);
      requestContext.services.auth.requireHost(requestContext.actor);
      const result = await requestContext.services.runtime.upgradeRuntime();
      return c.json(buildSuccessResponse(requestContext.requestId, result));
    },
  );
}
