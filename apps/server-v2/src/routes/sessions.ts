import type { Context, Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { HTTPException } from "hono/http-exception";
import { TextEncoder } from "node:util";
import { getRequestContext, type AppBindings } from "../context/request-context.js";
import { buildSuccessResponse } from "../http.js";
import { jsonResponse, withCommonErrorResponses } from "../openapi.js";
import {
  acceptedActionResponseSchema,
  commandRequestSchema,
  deletedActionResponseSchema,
  messageIdParamsSchema,
  messageListResponseSchema,
  messagePartParamsSchema,
  messagePartUpdateRequestSchema,
  messageResponseSchema,
  messageSendRequestSchema,
  promptAsyncRequestSchema,
  revertRequestSchema,
  sessionCreateRequestSchema,
  sessionForkRequestSchema,
  sessionIdParamsSchema,
  sessionListQuerySchema,
  sessionListResponseSchema,
  sessionMessagesQuerySchema,
  sessionResponseSchema,
  sessionSnapshotResponseSchema,
  sessionStatusResponseSchema,
  sessionStatusesResponseSchema,
  sessionSummarizeRequestSchema,
  sessionTodoListResponseSchema,
  sessionUpdateRequestSchema,
  shellRequestSchema,
  workspaceEventSchema,
} from "../schemas/sessions.js";
import { routePaths } from "./route-paths.js";

function parseQuery<T>(schema: { parse(input: unknown): T }, url: string) {
  const searchParams = new URL(url).searchParams;
  const query: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    query[key] = value;
  }
  return schema.parse(query);
}

async function parseBody<T>(schema: { parse(input: unknown): T }, request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    return schema.parse({});
  }
  return schema.parse(await request.json());
}

function requireReadableWorkspace(c: Context<AppBindings>) {
  const requestContext = getRequestContext(c);
  requestContext.services.auth.requireVisibleRead(requestContext.actor);
  const workspaceId = c.req.param("workspaceId") ?? "";
  const workspace = requestContext.services.workspaceRegistry.getById(
    workspaceId,
    { includeHidden: requestContext.actor.kind === "host" },
  );
  if (!workspace) {
    throw new HTTPException(404, { message: `Workspace not found: ${workspaceId}` });
  }
  return { requestContext, workspaceId };
}

function createSseResponse(stream: AsyncIterable<unknown>, signal?: AbortSignal) {
  const encoder = new TextEncoder();
  let eventId = 0;
  const iterator = stream[Symbol.asyncIterator]();
  return new Response(new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) {
            controller.close();
            return;
          }
          eventId += 1;
          controller.enqueue(encoder.encode(`id: ${eventId}\ndata: ${JSON.stringify(next.value)}\n\n`));
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      if (typeof iterator.return === "function") {
        await iterator.return();
      }
    },
  }), {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    },
  });
}

export function registerSessionRoutes(app: Hono<AppBindings>) {
  app.get(
    routePaths.workspaces.sessions.base(),
    describeRoute({
      tags: ["Sessions"],
      summary: "List workspace sessions",
      description: "Returns the normalized session inventory for the resolved local OpenCode or remote OpenWork workspace backend.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace sessions returned successfully.", sessionListResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireReadableWorkspace(c);
      const query = parseQuery(sessionListQuerySchema, c.req.url);
      const items = await requestContext.services.sessions.listSessions(workspaceId, query);
      return c.json(buildSuccessResponse(requestContext.requestId, { items }));
    },
  );

  app.get(
    routePaths.workspaces.sessions.statuses(),
    describeRoute({
      tags: ["Sessions"],
      summary: "List workspace session statuses",
      description: "Returns the latest normalized session status map for the resolved workspace backend.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace session statuses returned successfully.", sessionStatusesResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireReadableWorkspace(c);
      const items = await requestContext.services.sessions.listSessionStatuses(workspaceId);
      return c.json(buildSuccessResponse(requestContext.requestId, { items }));
    },
  );

  app.post(
    routePaths.workspaces.sessions.base(),
    describeRoute({
      tags: ["Sessions"],
      summary: "Create a workspace session",
      description: "Creates a new session inside the resolved workspace backend.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace session created successfully.", sessionResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireReadableWorkspace(c);
      const body = await parseBody(sessionCreateRequestSchema, c.req.raw);
      const session = await requestContext.services.sessions.createSession(workspaceId, body as Record<string, unknown>);
      return c.json(buildSuccessResponse(requestContext.requestId, session));
    },
  );

  app.get(
    routePaths.workspaces.sessions.byId(),
    describeRoute({
      tags: ["Sessions"],
      summary: "Get workspace session detail",
      description: "Returns one normalized session by workspace and session identifier.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace session returned successfully.", sessionResponseSchema),
      }, { includeNotFound: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireReadableWorkspace(c);
      const params = sessionIdParamsSchema.parse(c.req.param());
      const session = await requestContext.services.sessions.getSession(workspaceId, params.sessionId);
      return c.json(buildSuccessResponse(requestContext.requestId, session));
    },
  );

  app.patch(
    routePaths.workspaces.sessions.byId(),
    describeRoute({
      tags: ["Sessions"],
      summary: "Update a workspace session",
      description: "Updates a normalized session inside the resolved workspace backend.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace session updated successfully.", sessionResponseSchema),
      }, { includeInvalidRequest: true, includeNotFound: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireReadableWorkspace(c);
      const params = sessionIdParamsSchema.parse(c.req.param());
      const body = await parseBody(sessionUpdateRequestSchema, c.req.raw);
      const session = await requestContext.services.sessions.updateSession(workspaceId, params.sessionId, body as Record<string, unknown>);
      return c.json(buildSuccessResponse(requestContext.requestId, session));
    },
  );

  app.delete(
    routePaths.workspaces.sessions.byId(),
    describeRoute({
      tags: ["Sessions"],
      summary: "Delete a workspace session",
      description: "Deletes a session inside the resolved workspace backend.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace session deleted successfully.", deletedActionResponseSchema),
      }, { includeNotFound: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireReadableWorkspace(c);
      const params = sessionIdParamsSchema.parse(c.req.param());
      await requestContext.services.sessions.deleteSession(workspaceId, params.sessionId);
      return c.json(buildSuccessResponse(requestContext.requestId, { deleted: true }));
    },
  );

  app.get(
    routePaths.workspaces.sessions.status(),
    describeRoute({
      tags: ["Sessions"],
      summary: "Get one session status",
      description: "Returns the normalized status for a single session.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace session status returned successfully.", sessionStatusResponseSchema),
      }, { includeNotFound: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireReadableWorkspace(c);
      const params = sessionIdParamsSchema.parse(c.req.param());
      const status = await requestContext.services.sessions.getSessionStatus(workspaceId, params.sessionId);
      return c.json(buildSuccessResponse(requestContext.requestId, status));
    },
  );

  app.get(
    routePaths.workspaces.sessions.todo(),
    describeRoute({
      tags: ["Sessions"],
      summary: "List one session todos",
      description: "Returns the normalized todo list for a single session.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace session todos returned successfully.", sessionTodoListResponseSchema),
      }, { includeNotFound: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireReadableWorkspace(c);
      const params = sessionIdParamsSchema.parse(c.req.param());
      const items = await requestContext.services.sessions.listTodos(workspaceId, params.sessionId);
      return c.json(buildSuccessResponse(requestContext.requestId, { items }));
    },
  );

  app.get(
    routePaths.workspaces.sessions.snapshot(),
    describeRoute({
      tags: ["Sessions"],
      summary: "Get one session snapshot",
      description: "Returns session detail, messages, todos, and status in one normalized payload for detail surfaces.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace session snapshot returned successfully.", sessionSnapshotResponseSchema),
      }, { includeInvalidRequest: true, includeNotFound: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireReadableWorkspace(c);
      const params = sessionIdParamsSchema.parse(c.req.param());
      const query = parseQuery(sessionMessagesQuerySchema, c.req.url);
      const snapshot = await requestContext.services.sessions.getSessionSnapshot(workspaceId, params.sessionId, query);
      return c.json(buildSuccessResponse(requestContext.requestId, snapshot));
    },
  );

  app.get(
    routePaths.workspaces.sessions.messages.base(),
    describeRoute({
      tags: ["Messages"],
      summary: "List session messages",
      description: "Returns the normalized message list for a single session.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace session messages returned successfully.", messageListResponseSchema),
      }, { includeInvalidRequest: true, includeNotFound: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireReadableWorkspace(c);
      const params = sessionIdParamsSchema.parse(c.req.param());
      const query = parseQuery(sessionMessagesQuerySchema, c.req.url);
      const items = await requestContext.services.sessions.listMessages(workspaceId, params.sessionId, query);
      return c.json(buildSuccessResponse(requestContext.requestId, { items }));
    },
  );

  app.get(
    routePaths.workspaces.sessions.messages.byId(),
    describeRoute({
      tags: ["Messages"],
      summary: "Get one session message",
      description: "Returns one normalized message by workspace, session, and message identifier.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace session message returned successfully.", messageResponseSchema),
      }, { includeNotFound: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireReadableWorkspace(c);
      const params = messageIdParamsSchema.parse(c.req.param());
      const message = await requestContext.services.sessions.getMessage(workspaceId, params.sessionId, params.messageId);
      return c.json(buildSuccessResponse(requestContext.requestId, message));
    },
  );

  app.post(
    routePaths.workspaces.sessions.messages.base(),
    describeRoute({
      tags: ["Messages"],
      summary: "Send a session message",
      description: "Sends a normalized message payload to the resolved workspace backend.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace session message accepted successfully.", acceptedActionResponseSchema),
      }, { includeInvalidRequest: true, includeNotFound: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireReadableWorkspace(c);
      const params = sessionIdParamsSchema.parse(c.req.param());
      const body = await parseBody(messageSendRequestSchema, c.req.raw);
      await requestContext.services.sessions.sendMessage(workspaceId, params.sessionId, body as Record<string, unknown>);
      return c.json(buildSuccessResponse(requestContext.requestId, { accepted: true }));
    },
  );

  app.delete(
    routePaths.workspaces.sessions.messages.byId(),
    describeRoute({
      tags: ["Messages"],
      summary: "Delete a session message",
      description: "Deletes one message inside the resolved session backend.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace session message deleted successfully.", deletedActionResponseSchema),
      }, { includeNotFound: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireReadableWorkspace(c);
      const params = messageIdParamsSchema.parse(c.req.param());
      await requestContext.services.sessions.deleteMessage(workspaceId, params.sessionId, params.messageId);
      return c.json(buildSuccessResponse(requestContext.requestId, { deleted: true }));
    },
  );

  app.patch(
    routePaths.workspaces.sessions.messages.partById(),
    describeRoute({
      tags: ["Messages"],
      summary: "Update a session message part",
      description: "Updates one message part inside the resolved session backend where the upstream backend supports it.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace session message part updated successfully.", acceptedActionResponseSchema),
      }, { includeInvalidRequest: true, includeNotFound: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireReadableWorkspace(c as never);
      const params = messagePartParamsSchema.parse(c.req.param());
      const body = await parseBody(messagePartUpdateRequestSchema, c.req.raw);
      await requestContext.services.sessions.updateMessagePart(
        workspaceId,
        params.sessionId,
        params.messageId,
        params.partId,
        body as Record<string, unknown>,
      );
      return c.json(buildSuccessResponse(requestContext.requestId, { accepted: true }));
    },
  );

  app.delete(
    routePaths.workspaces.sessions.messages.partById(),
    describeRoute({
      tags: ["Messages"],
      summary: "Delete a session message part",
      description: "Deletes one message part inside the resolved session backend where the upstream backend supports it.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace session message part deleted successfully.", deletedActionResponseSchema),
      }, { includeNotFound: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireReadableWorkspace(c as never);
      const params = messagePartParamsSchema.parse(c.req.param());
      await requestContext.services.sessions.deleteMessagePart(workspaceId, params.sessionId, params.messageId, params.partId);
      return c.json(buildSuccessResponse(requestContext.requestId, { deleted: true }));
    },
  );

  const actionRoute = (
    path: string,
    summary: string,
    description: string,
    handler: (input: {
      body: Record<string, unknown>;
      requestContext: ReturnType<typeof getRequestContext>;
      sessionId: string;
      workspaceId: string;
    }) => Promise<unknown>,
    bodySchema?: { parse(input: unknown): Record<string, unknown> },
    responseSchema: any = acceptedActionResponseSchema,
  ) => {
    app.post(
      path,
      describeRoute({
        tags: ["Sessions"],
        summary,
        description,
        responses: withCommonErrorResponses({
          200: jsonResponse(`${summary} completed successfully.`, responseSchema),
        }, { includeInvalidRequest: true, includeNotFound: true, includeUnauthorized: true }),
      }),
      async (c) => {
        const { requestContext, workspaceId } = requireReadableWorkspace(c);
        const params = sessionIdParamsSchema.parse(c.req.param());
        const body = bodySchema ? await parseBody(bodySchema, c.req.raw) : {};
        const result = await handler({ body, requestContext, sessionId: params.sessionId, workspaceId });
        return c.json(buildSuccessResponse(requestContext.requestId, result ?? { accepted: true }));
      },
    );
  };

  actionRoute(
    routePaths.workspaces.sessions.init(),
    "Initialize a session",
    "Runs the upstream session init primitive through the workspace-first API.",
    ({ body, requestContext, sessionId, workspaceId }) => requestContext.services.sessions.initSession(workspaceId, sessionId, body),
  );
  actionRoute(
    routePaths.workspaces.sessions.fork(),
    "Fork a session",
    "Forks a session inside the resolved workspace backend.",
    ({ body, requestContext, sessionId, workspaceId }) => requestContext.services.sessions.forkSession(workspaceId, sessionId, body),
    sessionForkRequestSchema as never,
    sessionResponseSchema,
  );
  actionRoute(
    routePaths.workspaces.sessions.abort(),
    "Abort a session",
    "Aborts an in-flight session run through the workspace-first API.",
    ({ requestContext, sessionId, workspaceId }) => requestContext.services.sessions.abortSession(workspaceId, sessionId),
  );
  actionRoute(
    routePaths.workspaces.sessions.share(),
    "Share a session",
    "Calls the upstream share primitive when the resolved backend supports it.",
    ({ requestContext, sessionId, workspaceId }) => requestContext.services.sessions.shareSession(workspaceId, sessionId),
  );
  app.delete(
    routePaths.workspaces.sessions.share(),
    describeRoute({
      tags: ["Sessions"],
      summary: "Unshare a session",
      description: "Calls the upstream unshare primitive when the resolved backend supports it.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Session unshared successfully.", acceptedActionResponseSchema),
      }, { includeNotFound: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireReadableWorkspace(c);
      const params = sessionIdParamsSchema.parse(c.req.param());
      await requestContext.services.sessions.unshareSession(workspaceId, params.sessionId);
      return c.json(buildSuccessResponse(requestContext.requestId, { accepted: true }));
    },
  );
  actionRoute(
    routePaths.workspaces.sessions.summarize(),
    "Summarize a session",
    "Runs the upstream summarize or compact primitive for the selected session.",
    ({ body, requestContext, sessionId, workspaceId }) => requestContext.services.sessions.summarizeSession(workspaceId, sessionId, body),
    sessionSummarizeRequestSchema as never,
  );
  actionRoute(
    routePaths.workspaces.sessions.promptAsync(),
    "Send an async prompt",
    "Sends a prompt_async request to the resolved session backend for composer flows.",
    ({ body, requestContext, sessionId, workspaceId }) => requestContext.services.sessions.promptAsync(workspaceId, sessionId, body),
    promptAsyncRequestSchema as never,
  );
  actionRoute(
    routePaths.workspaces.sessions.command(),
    "Run a session command",
    "Runs a slash-command style session command through the workspace-first API.",
    ({ body, requestContext, sessionId, workspaceId }) => requestContext.services.sessions.command(workspaceId, sessionId, body),
    commandRequestSchema as never,
  );
  actionRoute(
    routePaths.workspaces.sessions.shell(),
    "Run a session shell command",
    "Runs a shell command inside the resolved session backend.",
    ({ body, requestContext, sessionId, workspaceId }) => requestContext.services.sessions.shell(workspaceId, sessionId, body),
    shellRequestSchema as never,
  );
  actionRoute(
    routePaths.workspaces.sessions.revert(),
    "Revert session history",
    "Reverts a session to the requested message boundary.",
    ({ body, requestContext, sessionId, workspaceId }) =>
      requestContext.services.sessions.revert(workspaceId, sessionId, body as { messageID: string }),
    revertRequestSchema as never,
    sessionResponseSchema,
  );
  actionRoute(
    routePaths.workspaces.sessions.unrevert(),
    "Restore reverted session history",
    "Restores previously reverted session history.",
    ({ requestContext, sessionId, workspaceId }) => requestContext.services.sessions.unrevert(workspaceId, sessionId),
    undefined,
    sessionResponseSchema,
  );

  app.get(
    routePaths.workspaces.events(),
    describeRoute({
      tags: ["Sessions"],
      summary: "Stream workspace events",
      description: "Streams normalized session and message events for one workspace over Server-Sent Events.",
      responses: withCommonErrorResponses({
        200: {
          description: "Workspace events streamed successfully.",
          content: {
            "text/event-stream": {
              schema: resolver(workspaceEventSchema),
            },
          },
        },
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireReadableWorkspace(c);
      const abort = new AbortController();
      c.req.raw.signal.addEventListener("abort", () => abort.abort(), { once: true });
      const stream = await requestContext.services.sessions.streamWorkspaceEvents(workspaceId, abort.signal);
      return createSseResponse(stream, abort.signal);
    },
  );
}
