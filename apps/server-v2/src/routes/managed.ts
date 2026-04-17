import type { Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { getRequestContext, type AppBindings } from "../context/request-context.js";
import { buildSuccessResponse, RouteError } from "../http.js";
import { jsonResponse, withCommonErrorResponses } from "../openapi.js";
import {
  cloudSigninResponseSchema,
  cloudSigninValidationResponseSchema,
  cloudSigninWriteSchema,
  hubSkillInstallResponseSchema,
  hubSkillInstallWriteSchema,
  hubSkillListResponseSchema,
  managedAssignmentWriteSchema,
  managedDeleteResponseSchema,
  managedItemListResponseSchema,
  managedItemResponseSchema,
  managedItemWriteSchema,
  routerBindingListResponseSchema,
  routerBindingWriteSchema,
  routerHealthResponseSchemaCompat,
  routerIdentityListResponseSchema,
  routerMutationResponseSchema,
  routerSendWriteSchema,
  routerSlackWriteSchema,
  routerTelegramInfoResponseSchema,
  routerTelegramWriteSchema,
  scheduledJobDeleteResponseSchema,
  scheduledJobListResponseSchema,
  sharedBundleFetchResponseSchema,
  sharedBundleFetchWriteSchema,
  sharedBundlePublishResponseSchema,
  sharedBundlePublishWriteSchema,
  workspaceExportResponseSchema,
  workspaceImportResponseSchema,
  workspaceImportWriteSchema,
  workspaceMcpListResponseSchema,
  workspaceMcpWriteSchema,
  workspacePluginListResponseSchema,
  workspacePluginWriteSchema,
  workspaceShareResponseSchema,
  workspaceSkillDeleteResponseSchema,
  workspaceSkillListResponseSchema,
  workspaceSkillResponseSchema,
  workspaceSkillWriteSchema,
} from "../schemas/managed.js";
import { routePaths } from "./route-paths.js";

function parseJsonBody<T>(schema: { parse(input: unknown): T }, request: Request) {
  return request.json().then((body) => schema.parse(body));
}

function requireVisible(c: Context<AppBindings>) {
  const requestContext = getRequestContext(c);
  requestContext.services.auth.requireVisibleRead(requestContext.actor);
  return requestContext;
}

function requireWorkspace(c: Context<AppBindings>) {
  const requestContext = requireVisible(c);
  const workspaceId = c.req.param("workspaceId") ?? "";
  return { requestContext, workspaceId };
}

function addCompatibilityRoute(
  app: Hono<AppBindings>,
  method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT",
  path: string,
  handler: (c: Context<AppBindings>) => Promise<Response> | Response,
) {
  if (method === "GET") app.get(path, handler);
  if (method === "POST") app.post(path, handler);
  if (method === "PUT") app.put(path, handler);
  if (method === "PATCH") app.patch(path, handler);
  if (method === "DELETE") app.delete(path, handler);
}

export function registerManagedRoutes(app: Hono<AppBindings>) {
  for (const kind of ["mcps", "plugins", "providerConfigs", "skills"] as const) {
    app.get(
      routePaths.system.managed.list(kind),
      describeRoute({
        tags: ["Managed"],
        summary: `List managed ${kind}`,
        description: `Returns the server-owned ${kind} records and explicit workspace assignments.`,
        responses: withCommonErrorResponses({
          200: jsonResponse(`Managed ${kind} returned successfully.`, managedItemListResponseSchema),
        }, { includeUnauthorized: true }),
      }),
      (c) => {
        const requestContext = requireVisible(c);
        return c.json(buildSuccessResponse(requestContext.requestId, { items: requestContext.services.managed.listManaged(kind) }));
      },
    );

    app.post(
      routePaths.system.managed.list(kind),
      describeRoute({
        tags: ["Managed"],
        summary: `Create managed ${kind.slice(0, -1)}`,
        description: `Creates a server-owned ${kind.slice(0, -1)} record and optionally assigns it to workspaces.`,
        responses: withCommonErrorResponses({
          200: jsonResponse(`Managed ${kind.slice(0, -1)} created successfully.`, managedItemResponseSchema),
        }, { includeInvalidRequest: true, includeUnauthorized: true }),
      }),
      async (c) => {
        const requestContext = requireVisible(c);
        const body = await parseJsonBody(managedItemWriteSchema, c.req.raw);
        return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.managed.createManaged(kind, body)));
      },
    );

    app.put(
      routePaths.system.managed.item(kind),
      describeRoute({
        tags: ["Managed"],
        summary: `Update managed ${kind.slice(0, -1)}`,
        description: `Updates a server-owned ${kind.slice(0, -1)} record.`,
        responses: withCommonErrorResponses({
          200: jsonResponse(`Managed ${kind.slice(0, -1)} updated successfully.`, managedItemResponseSchema),
        }, { includeInvalidRequest: true, includeNotFound: true, includeUnauthorized: true }),
      }),
      async (c) => {
        const requestContext = requireVisible(c);
        const itemId = c.req.param("itemId") ?? "";
        const body = await parseJsonBody(managedItemWriteSchema, c.req.raw);
        return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.managed.updateManaged(kind, itemId, body)));
      },
    );

    app.put(
      routePaths.system.managed.assignments(kind),
      describeRoute({
        tags: ["Managed"],
        summary: `Assign managed ${kind.slice(0, -1)} to workspaces`,
        description: `Replaces the workspace assignments for a server-owned managed item.`,
        responses: withCommonErrorResponses({
          200: jsonResponse(`Managed ${kind.slice(0, -1)} assignments updated successfully.`, managedItemResponseSchema),
        }, { includeInvalidRequest: true, includeNotFound: true, includeUnauthorized: true }),
      }),
      async (c) => {
        const requestContext = requireVisible(c);
        const itemId = c.req.param("itemId") ?? "";
        const body = await parseJsonBody(managedAssignmentWriteSchema, c.req.raw);
        return c.json(buildSuccessResponse(requestContext.requestId, await requestContext.services.managed.updateAssignments(kind, itemId, body.workspaceIds)));
      },
    );

    app.delete(
      routePaths.system.managed.item(kind),
      describeRoute({
        tags: ["Managed"],
        summary: `Delete managed ${kind.slice(0, -1)}`,
        description: `Deletes a server-owned managed item and removes its workspace assignments.`,
        responses: withCommonErrorResponses({
          200: jsonResponse(`Managed ${kind.slice(0, -1)} deleted successfully.`, managedDeleteResponseSchema),
        }, { includeNotFound: true, includeUnauthorized: true }),
      }),
      async (c) => {
        const requestContext = requireVisible(c);
        const itemId = c.req.param("itemId") ?? "";
        return c.json(buildSuccessResponse(requestContext.requestId, await requestContext.services.managed.deleteManaged(kind, itemId)));
      },
    );
  }

  app.get(
    routePaths.system.cloudSignin,
    describeRoute({
      tags: ["Cloud"],
      summary: "Read cloud signin state",
      description: "Returns the server-owned cloud signin record when one is configured.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Cloud signin returned successfully.", cloudSigninResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const requestContext = requireVisible(c);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.managed.getCloudSignin()));
    },
  );

  app.put(
    routePaths.system.cloudSignin,
    describeRoute({
      tags: ["Cloud"],
      summary: "Persist cloud signin state",
      description: "Stores cloud signin metadata in the server-owned database.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Cloud signin persisted successfully.", cloudSigninResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const requestContext = requireVisible(c);
      const body = await parseJsonBody(cloudSigninWriteSchema, c.req.raw);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.managed.upsertCloudSignin(body)));
    },
  );

  app.post(
    "/system/cloud-signin/validate",
    describeRoute({
      tags: ["Cloud"],
      summary: "Validate cloud signin state",
      description: "Validates the stored cloud signin token against the configured cloud base URL.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Cloud signin validated successfully.", cloudSigninValidationResponseSchema),
      }, { includeNotFound: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const requestContext = requireVisible(c);
      return c.json(buildSuccessResponse(requestContext.requestId, await requestContext.services.managed.validateCloudSignin()));
    },
  );

  app.delete(
    routePaths.system.cloudSignin,
    describeRoute({
      tags: ["Cloud"],
      summary: "Clear cloud signin state",
      description: "Removes the server-owned cloud signin record for the current OpenWork server.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Cloud signin cleared successfully.", cloudSigninResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const requestContext = requireVisible(c);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.managed.clearCloudSignin()));
    },
  );

  app.get(
    routePaths.system.router.health,
    describeRoute({
      tags: ["Router"],
      summary: "Read router product health",
      description: "Returns the product-facing router health snapshot built from server-owned router state.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Router product health returned successfully.", routerHealthResponseSchemaCompat),
      }, { includeUnauthorized: true }),
    }),
    (c) => {
      const requestContext = requireVisible(c);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.router.getHealth()));
    },
  );

  app.post(
    routePaths.system.router.apply,
    describeRoute({
      tags: ["Router"],
      summary: "Apply router state",
      description: "Rematerializes the effective router config and reconciles the supervised router process.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Router state applied successfully.", routerMutationResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const requestContext = requireVisible(c);
      return c.json(buildSuccessResponse(requestContext.requestId, await requestContext.services.router.apply()));
    },
  );

  app.get(
    routePaths.system.router.identities("telegram"),
    describeRoute({
      tags: ["Router"],
      summary: "List Telegram identities",
      description: "Returns the server-owned Telegram router identities.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Telegram identities returned successfully.", routerIdentityListResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    (c) => {
      const requestContext = requireVisible(c);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.router.listTelegramIdentities()));
    },
  );

  app.post(
    routePaths.system.router.identities("telegram"),
    describeRoute({
      tags: ["Router"],
      summary: "Upsert Telegram identity",
      description: "Creates or updates a server-owned Telegram router identity.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Telegram identity upserted successfully.", routerMutationResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const requestContext = requireVisible(c);
      const body = await parseJsonBody(routerTelegramWriteSchema, c.req.raw);
      return c.json(buildSuccessResponse(requestContext.requestId, await requestContext.services.router.upsertTelegramIdentity(body)));
    },
  );

  app.get(
    routePaths.system.router.identities("slack"),
    describeRoute({
      tags: ["Router"],
      summary: "List Slack identities",
      description: "Returns the server-owned Slack router identities.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Slack identities returned successfully.", routerIdentityListResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    (c) => {
      const requestContext = requireVisible(c);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.router.listSlackIdentities()));
    },
  );

  app.post(
    routePaths.system.router.identities("slack"),
    describeRoute({
      tags: ["Router"],
      summary: "Upsert Slack identity",
      description: "Creates or updates a server-owned Slack router identity.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Slack identity upserted successfully.", routerMutationResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const requestContext = requireVisible(c);
      const body = await parseJsonBody(routerSlackWriteSchema, c.req.raw);
      return c.json(buildSuccessResponse(requestContext.requestId, await requestContext.services.router.upsertSlackIdentity(body)));
    },
  );

  app.get(
    routePaths.system.router.telegram,
    describeRoute({
      tags: ["Router"],
      summary: "Read Telegram router info",
      description: "Returns the current Telegram identity readiness summary for the router product surface.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Telegram router info returned successfully.", routerTelegramInfoResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const requestContext = requireVisible(c);
      return c.json(buildSuccessResponse(requestContext.requestId, await requestContext.services.router.getTelegramInfo()));
    },
  );

  app.get(
    routePaths.system.router.bindings,
    describeRoute({
      tags: ["Router"],
      summary: "List router bindings",
      description: "Returns the effective server-owned router bindings.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Router bindings returned successfully.", routerBindingListResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    (c) => {
      const requestContext = requireVisible(c);
      const url = new URL(c.req.url);
      const channel = url.searchParams.get("channel")?.trim() || undefined;
      const identityId = url.searchParams.get("identityId")?.trim() || undefined;
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.router.listBindings({ channel, identityId })));
    },
  );

  app.post(
    routePaths.system.router.bindings,
    describeRoute({
      tags: ["Router"],
      summary: "Set router binding",
      description: "Creates or updates a server-owned router binding.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Router binding updated successfully.", routerMutationResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const requestContext = requireVisible(c);
      const body = await parseJsonBody(routerBindingWriteSchema, c.req.raw);
      if (!body.directory?.trim()) {
        throw new RouteError(400, "invalid_request", "System router binding writes require a directory.");
      }
      return c.json(buildSuccessResponse(requestContext.requestId, await requestContext.services.router.setBinding({ channel: body.channel, directory: body.directory, identityId: body.identityId, peerId: body.peerId })));
    },
  );

  app.post(
    routePaths.system.router.send,
    describeRoute({
      tags: ["Router"],
      summary: "Send router message",
      description: "Sends an outbound router message through the supervised router runtime.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Router message delivered successfully.", routerMutationResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const requestContext = requireVisible(c);
      const body = await parseJsonBody(routerSendWriteSchema, c.req.raw);
      return c.json(buildSuccessResponse(requestContext.requestId, await requestContext.services.router.sendMessage(body)));
    },
  );

  app.get(
    routePaths.workspaces.share(),
    describeRoute({
      tags: ["Shares"],
      summary: "Read workspace share",
      description: "Returns the current workspace-scoped share record for a local workspace.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace share returned successfully.", workspaceShareResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    (c) => {
      const { requestContext, workspaceId } = requireWorkspace(c);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.managed.getWorkspaceShare(workspaceId)));
    },
  );

  app.post(
    routePaths.workspaces.share(),
    describeRoute({
      tags: ["Shares"],
      summary: "Expose workspace share",
      description: "Creates or rotates a workspace-scoped share access key for a local workspace.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace share exposed successfully.", workspaceShareResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    (c) => {
      const { requestContext, workspaceId } = requireWorkspace(c);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.managed.exposeWorkspaceShare(workspaceId)));
    },
  );

  app.delete(
    routePaths.workspaces.share(),
    describeRoute({
      tags: ["Shares"],
      summary: "Revoke workspace share",
      description: "Revokes the current workspace-scoped share access key for a local workspace.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace share revoked successfully.", workspaceShareResponseSchema),
      }, { includeNotFound: true, includeUnauthorized: true }),
    }),
    (c) => {
      const { requestContext, workspaceId } = requireWorkspace(c);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.managed.revokeWorkspaceShare(workspaceId)));
    },
  );

  app.get(
    routePaths.workspaces.export(),
    describeRoute({
      tags: ["Bundles"],
      summary: "Export workspace",
      description: "Builds a portable workspace export from the server-owned config and managed-resource state.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace exported successfully.", workspaceExportResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspace(c);
      const sensitiveMode = (new URL(c.req.url).searchParams.get("sensitive")?.trim() as "auto" | "exclude" | "include" | null) ?? "auto";
      const result = await requestContext.services.managed.exportWorkspace(workspaceId, { sensitiveMode: sensitiveMode === "exclude" || sensitiveMode === "include" || sensitiveMode === "auto" ? sensitiveMode : "auto" });
      if ("conflict" in result) {
        return c.json({ code: "workspace_export_requires_decision", details: { warnings: result.warnings }, message: "This workspace includes sensitive config. Choose whether to exclude it or include it before exporting." }, 409);
      }
      return c.json(buildSuccessResponse(requestContext.requestId, result));
    },
  );

  app.post(
    routePaths.workspaces.import(),
    describeRoute({
      tags: ["Bundles"],
      summary: "Import workspace",
      description: "Applies a portable workspace import through the server-owned config and managed-resource model.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace imported successfully.", workspaceImportResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspace(c);
      const body = await parseJsonBody(workspaceImportWriteSchema, c.req.raw);
      return c.json(buildSuccessResponse(requestContext.requestId, await requestContext.services.managed.importWorkspace(workspaceId, body)));
    },
  );

  app.post(
    "/share/bundles/publish",
    describeRoute({
      tags: ["Bundles"],
      summary: "Publish shared bundle",
      description: "Publishes a trusted shared bundle through the configured OpenWork bundle publisher.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Shared bundle published successfully.", sharedBundlePublishResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const requestContext = requireVisible(c);
      const body = await parseJsonBody(sharedBundlePublishWriteSchema, c.req.raw);
      return c.json(buildSuccessResponse(requestContext.requestId, await requestContext.services.managed.publishSharedBundle(body)));
    },
  );

  app.post(
    "/share/bundles/fetch",
    describeRoute({
      tags: ["Bundles"],
      summary: "Fetch shared bundle",
      description: "Fetches a trusted shared bundle through the configured OpenWork bundle publisher.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Shared bundle fetched successfully.", sharedBundleFetchResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const requestContext = requireVisible(c);
      const body = await parseJsonBody(sharedBundleFetchWriteSchema, c.req.raw);
      return c.json(buildSuccessResponse(requestContext.requestId, await requestContext.services.managed.fetchSharedBundle(body.bundleUrl, { timeoutMs: body.timeoutMs })));
    },
  );

  app.get(
    routePaths.workspaces.mcp(),
    describeRoute({
      tags: ["Managed"],
      summary: "List workspace MCPs",
      description: "Returns the effective workspace MCP records backed by server-owned managed state.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace MCPs returned successfully.", workspaceMcpListResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    (c) => {
      const { requestContext, workspaceId } = requireWorkspace(c);
      return c.json(buildSuccessResponse(requestContext.requestId, { items: requestContext.services.managed.listWorkspaceMcp(workspaceId) }));
    },
  );

  app.post(
    routePaths.workspaces.mcp(),
    describeRoute({
      tags: ["Managed"],
      summary: "Add workspace MCP",
      description: "Creates or updates a workspace-scoped MCP through server-owned managed state.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace MCP updated successfully.", workspaceMcpListResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspace(c);
      const body = await parseJsonBody(workspaceMcpWriteSchema, c.req.raw);
      return c.json(buildSuccessResponse(requestContext.requestId, await requestContext.services.managed.addWorkspaceMcp(workspaceId, body)));
    },
  );

  app.get(
    routePaths.workspaces.plugins(),
    describeRoute({
      tags: ["Managed"],
      summary: "List workspace plugins",
      description: "Returns the effective workspace plugins backed by server-owned managed state.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace plugins returned successfully.", workspacePluginListResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    (c) => {
      const { requestContext, workspaceId } = requireWorkspace(c);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.managed.listWorkspacePlugins(workspaceId)));
    },
  );

  app.post(
    routePaths.workspaces.plugins(),
    describeRoute({
      tags: ["Managed"],
      summary: "Add workspace plugin",
      description: "Creates or updates a workspace-scoped plugin through server-owned managed state.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace plugins updated successfully.", workspacePluginListResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
      async (c) => {
        const { requestContext, workspaceId } = requireWorkspace(c);
        const body = await parseJsonBody(workspacePluginWriteSchema, c.req.raw);
        return c.json(buildSuccessResponse(requestContext.requestId, await requestContext.services.managed.addWorkspacePlugin(workspaceId, body.spec)));
      },
    );

  app.get(
    routePaths.workspaces.scheduler.base(),
    describeRoute({
      tags: ["Managed"],
      summary: "List scheduled jobs",
      description: "Returns the scheduled jobs for a local workspace via the desktop scheduler store.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Scheduled jobs returned successfully.", scheduledJobListResponseSchema),
      }, { includeNotFound: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspace(c);
      return c.json(buildSuccessResponse(requestContext.requestId, await requestContext.services.scheduler.listWorkspaceJobs(workspaceId)));
    },
  );

  app.delete(
    routePaths.workspaces.scheduler.byName(),
    describeRoute({
      tags: ["Managed"],
      summary: "Delete scheduled job",
      description: "Deletes a scheduled job for a local workspace via the desktop scheduler store.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Scheduled job deleted successfully.", scheduledJobDeleteResponseSchema),
      }, { includeNotFound: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspace(c);
      return c.json(buildSuccessResponse(requestContext.requestId, await requestContext.services.scheduler.deleteWorkspaceJob(workspaceId, c.req.param("name") ?? "")));
    },
  );

  app.get(
    routePaths.workspaces.skills(),
    describeRoute({
      tags: ["Managed"],
      summary: "List workspace skills",
      description: "Returns the effective workspace skills backed by server-owned managed state.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace skills returned successfully.", workspaceSkillListResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    (c) => {
      const { requestContext, workspaceId } = requireWorkspace(c);
      return c.json(buildSuccessResponse(requestContext.requestId, { items: requestContext.services.managed.listWorkspaceSkills(workspaceId) }));
    },
  );

  app.post(
    routePaths.workspaces.skills(),
    describeRoute({
      tags: ["Managed"],
      summary: "Upsert workspace skill",
      description: "Creates or updates a workspace-scoped skill through server-owned managed state.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace skill updated successfully.", workspaceSkillResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspace(c);
      const body = await parseJsonBody(workspaceSkillWriteSchema, c.req.raw);
      const item = await requestContext.services.managed.upsertWorkspaceSkill(workspaceId, body);
      return c.json(buildSuccessResponse(requestContext.requestId, { content: requestContext.services.managed.getWorkspaceSkill(workspaceId, item.name).content, item }));
    },
  );

  app.get(
    routePaths.workspaces.hubSkills,
    describeRoute({
      tags: ["Managed"],
      summary: "List hub skills",
      description: "Returns the available Skill Hub catalog backed by trusted GitHub sources.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Hub skills returned successfully.", hubSkillListResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const requestContext = requireVisible(c);
      const url = new URL(c.req.url);
      return c.json(buildSuccessResponse(requestContext.requestId, await requestContext.services.managed.listHubSkills({ owner: url.searchParams.get("owner") ?? undefined, ref: url.searchParams.get("ref") ?? undefined, repo: url.searchParams.get("repo") ?? undefined })));
    },
  );

  app.post(
    `${routePaths.workspaces.skills()}/hub/:name`,
    describeRoute({
      tags: ["Managed"],
      summary: "Install hub skill",
      description: "Installs a trusted Skill Hub skill into server-owned managed state for a workspace.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Hub skill installed successfully.", hubSkillInstallResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspace(c);
      const body = await parseJsonBody(hubSkillInstallWriteSchema, c.req.raw).catch(() => ({} as any));
      return c.json(buildSuccessResponse(requestContext.requestId, await requestContext.services.managed.installHubSkill(workspaceId, { name: c.req.param("name") ?? "", overwrite: body.overwrite, repo: body.repo })));
    },
  );

  addCompatibilityRoute(app, "GET", "/workspace/:workspaceId/mcp", (c) => {
    const { requestContext, workspaceId } = requireWorkspace(c);
    return c.json({ items: requestContext.services.managed.listWorkspaceMcp(workspaceId) });
  });
  addCompatibilityRoute(app, "POST", "/workspace/:workspaceId/mcp", async (c) => {
    const { requestContext, workspaceId } = requireWorkspace(c);
    const body = await parseJsonBody(workspaceMcpWriteSchema, c.req.raw);
    return c.json(await requestContext.services.managed.addWorkspaceMcp(workspaceId, body));
  });
  addCompatibilityRoute(app, "DELETE", "/workspace/:workspaceId/mcp/:name", async (c) => {
    const { requestContext, workspaceId } = requireWorkspace(c);
    return c.json(await requestContext.services.managed.removeWorkspaceMcp(workspaceId, c.req.param("name") ?? ""));
  });
  addCompatibilityRoute(app, "DELETE", "/workspace/:workspaceId/mcp/:name/auth", (c) => c.json({ ok: true }));

  addCompatibilityRoute(app, "GET", "/workspace/:workspaceId/plugins", (c) => {
    const { requestContext, workspaceId } = requireWorkspace(c);
    return c.json(requestContext.services.managed.listWorkspacePlugins(workspaceId));
  });
  addCompatibilityRoute(app, "POST", "/workspace/:workspaceId/plugins", async (c) => {
    const { requestContext, workspaceId } = requireWorkspace(c);
    const body = await parseJsonBody(workspacePluginWriteSchema, c.req.raw);
    return c.json(await requestContext.services.managed.addWorkspacePlugin(workspaceId, body.spec));
  });
  addCompatibilityRoute(app, "DELETE", "/workspace/:workspaceId/plugins/:name", async (c) => {
    const { requestContext, workspaceId } = requireWorkspace(c);
    return c.json(await requestContext.services.managed.removeWorkspacePlugin(workspaceId, c.req.param("name") ?? ""));
  });

  addCompatibilityRoute(app, "GET", "/workspace/:workspaceId/skills", (c) => {
    const { requestContext, workspaceId } = requireWorkspace(c);
    return c.json({ items: requestContext.services.managed.listWorkspaceSkills(workspaceId) });
  });
  addCompatibilityRoute(app, "GET", "/workspace/:workspaceId/scheduler/jobs", async (c) => {
    const { requestContext, workspaceId } = requireWorkspace(c);
    return c.json(await requestContext.services.scheduler.listWorkspaceJobs(workspaceId));
  });
  addCompatibilityRoute(app, "DELETE", "/workspace/:workspaceId/scheduler/jobs/:name", async (c) => {
    const { requestContext, workspaceId } = requireWorkspace(c);
    return c.json(await requestContext.services.scheduler.deleteWorkspaceJob(workspaceId, c.req.param("name") ?? ""));
  });
  addCompatibilityRoute(app, "GET", "/workspace/:workspaceId/skills/:name", (c) => {
    const { requestContext, workspaceId } = requireWorkspace(c);
    return c.json(requestContext.services.managed.getWorkspaceSkill(workspaceId, c.req.param("name") ?? ""));
  });
  addCompatibilityRoute(app, "POST", "/workspace/:workspaceId/skills", async (c) => {
    const { requestContext, workspaceId } = requireWorkspace(c);
    const body = await parseJsonBody(workspaceSkillWriteSchema, c.req.raw);
    return c.json(await requestContext.services.managed.upsertWorkspaceSkill(workspaceId, body));
  });
  addCompatibilityRoute(app, "DELETE", "/workspace/:workspaceId/skills/:name", async (c) => {
    const { requestContext, workspaceId } = requireWorkspace(c);
    return c.json(await requestContext.services.managed.deleteWorkspaceSkill(workspaceId, c.req.param("name") ?? ""));
  });
  addCompatibilityRoute(app, "GET", "/hub/skills", async (c) => {
    const requestContext = requireVisible(c);
    const url = new URL(c.req.url);
    return c.json(await requestContext.services.managed.listHubSkills({ owner: url.searchParams.get("owner") ?? undefined, ref: url.searchParams.get("ref") ?? undefined, repo: url.searchParams.get("repo") ?? undefined }));
  });
  addCompatibilityRoute(app, "POST", "/workspace/:workspaceId/skills/hub/:name", async (c) => {
    const { requestContext, workspaceId } = requireWorkspace(c);
    const body = await parseJsonBody(hubSkillInstallWriteSchema, c.req.raw).catch(() => ({} as any));
    return c.json({ ok: true, ...(await requestContext.services.managed.installHubSkill(workspaceId, { name: c.req.param("name") ?? "", overwrite: body.overwrite, repo: body.repo })) });
  });

  const workspaceRouterPaths = [
    "/workspace/:workspaceId/opencode-router",
    routePaths.workspaces.router.base(),
  ];
  for (const basePath of workspaceRouterPaths) {
    addCompatibilityRoute(app, "GET", `${basePath}/health`, (c) => {
      requireWorkspace(c);
      return c.json(getRequestContext(c).services.router.getHealth());
    });
    addCompatibilityRoute(app, "POST", `${basePath}/telegram-token`, async (c) => c.json(await getRequestContext(c).services.router.setTelegramToken((await parseJsonBody(routerTelegramWriteSchema, c.req.raw)).token)));
    addCompatibilityRoute(app, "GET", `${basePath}/telegram`, async (c) => c.json(await getRequestContext(c).services.router.getTelegramInfo()));
    addCompatibilityRoute(app, "POST", `${basePath}/telegram-enabled`, async (c) => {
      const body = await c.req.json();
      return c.json(await getRequestContext(c).services.router.setTelegramEnabled(body.enabled === true, { clearToken: body.clearToken === true }));
    });
    addCompatibilityRoute(app, "GET", `${basePath}/identities/telegram`, (c) => c.json(getRequestContext(c).services.router.listTelegramIdentities()));
    addCompatibilityRoute(app, "POST", `${basePath}/identities/telegram`, async (c) => c.json(await getRequestContext(c).services.router.upsertTelegramIdentity(await parseJsonBody(routerTelegramWriteSchema, c.req.raw))));
    addCompatibilityRoute(app, "DELETE", `${basePath}/identities/telegram/:identityId`, async (c) => c.json(await getRequestContext(c).services.router.deleteTelegramIdentity(c.req.param("identityId") ?? "")));
    addCompatibilityRoute(app, "GET", `${basePath}/identities/slack`, (c) => c.json(getRequestContext(c).services.router.listSlackIdentities()));
    addCompatibilityRoute(app, "POST", `${basePath}/identities/slack`, async (c) => c.json(await getRequestContext(c).services.router.upsertSlackIdentity(await parseJsonBody(routerSlackWriteSchema, c.req.raw))));
    addCompatibilityRoute(app, "DELETE", `${basePath}/identities/slack/:identityId`, async (c) => c.json(await getRequestContext(c).services.router.deleteSlackIdentity(c.req.param("identityId") ?? "")));
    addCompatibilityRoute(app, "POST", `${basePath}/slack-tokens`, async (c) => {
      const body = await parseJsonBody(routerSlackWriteSchema, c.req.raw);
      return c.json(await getRequestContext(c).services.router.setSlackTokens(body.botToken, body.appToken));
    });
    addCompatibilityRoute(app, "GET", `${basePath}/bindings`, (c) => {
      const requestContext = getRequestContext(c);
      const url = new URL(c.req.url);
      return c.json(requestContext.services.router.listBindings({ channel: url.searchParams.get("channel") ?? undefined, identityId: url.searchParams.get("identityId") ?? undefined }));
    });
    addCompatibilityRoute(app, "POST", `${basePath}/bindings`, async (c) => {
      const requestContext = getRequestContext(c);
      const body = await parseJsonBody(routerBindingWriteSchema, c.req.raw);
      const workspaceId = c.req.param("workspaceId") ?? "";
      const workspace = requestContext.services.workspaceRegistry.getById(workspaceId, { includeHidden: true });
      const directory = body.directory?.trim() || workspace?.backend.local?.dataDir || "";
      return c.json(await requestContext.services.router.setBinding({ channel: body.channel, directory, identityId: body.identityId, peerId: body.peerId }));
    });
    addCompatibilityRoute(app, "POST", `${basePath}/send`, async (c) => c.json(await getRequestContext(c).services.router.sendMessage(await parseJsonBody(routerSendWriteSchema, c.req.raw))));
  }

  addCompatibilityRoute(app, "GET", "/workspace/:workspaceId/export", async (c) => {
    const { requestContext, workspaceId } = requireWorkspace(c);
    const sensitiveMode = (new URL(c.req.url).searchParams.get("sensitive")?.trim() as "auto" | "exclude" | "include" | null) ?? "auto";
    const result = await requestContext.services.managed.exportWorkspace(workspaceId, { sensitiveMode: sensitiveMode === "exclude" || sensitiveMode === "include" || sensitiveMode === "auto" ? sensitiveMode : "auto" });
    if ("conflict" in result) {
      return c.json({ code: "workspace_export_requires_decision", details: { warnings: result.warnings }, message: "This workspace includes sensitive config. Choose whether to exclude it or include it before exporting." }, 409);
    }
    return c.json(result);
  });
  addCompatibilityRoute(app, "POST", "/workspace/:workspaceId/import", async (c) => {
    const { requestContext, workspaceId } = requireWorkspace(c);
    return c.json(await requestContext.services.managed.importWorkspace(workspaceId, await c.req.json()));
  });
}
