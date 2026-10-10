import { EventHub } from "./events/hub.js";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { createLocalControls } from "./admin/control.js";
import {
  BridgeError,
  parseSend,
  parseApprovalReply,
  assertContract,
  record,
  type Platform,
  type Host,
} from "./contract/index.js";
import type { OpenWorkAdapter } from "./adapters/types.js";
import { Store, type Device } from "./storage/store.js";
import { Pairing } from "./auth/pairing.js";
import { Ledger } from "./mutations/ledger.js";
import { adminHTML, adminJS, adminCSS } from "./admin/public.js";
interface Options {
  store: Store;
  pairing: Pairing;
  adapter: OpenWorkAdapter;
  platform: Platform;
  architecture: string;
  origin: string;
}
export function createServers(o: Options) {
  const settings = {
    logger: false,
    bodyLimit: 40 * 1024,
    requestTimeout: 15000,
    connectionTimeout: 15000,
    exposeHeadRoutes: false,
  };
  const remote = Fastify(settings),
    admin = Fastify(settings),
    adminSession = randomBytes(32).toString("base64url"),
    ledger = new Ledger(o.store);
  const hub = new EventHub(o.adapter);
  const devices = new WeakMap<FastifyRequest, Device>();
  const streams = new Map<string, Set<() => void>>();
  const host = (): Host =>
    assertContract("Host", {
      hostId: o.store.snapshot.hostId,
      displayName: o.store.snapshot.displayName,
      platform: o.platform,
      architecture: o.architecture,
      runtimeKind: "desktop",
      protocolVersion: 1,
      upstreamVersion: o.adapter.version,
      compatibility: o.adapter.compatibility,
      capabilities: o.adapter.capabilities,
    });
  const controls = createLocalControls({
    store: o.store,
    pairing: o.pairing,
    adapter: o.adapter,
    origin: o.origin,
    host,
    closeDeviceStreams: (id) => {
      for (const close of streams.get(id) ?? []) close();
      streams.delete(id);
    },
  });
  const error = (e: Error, req: FastifyRequest, reply: FastifyReply) => {
    const status = Number("statusCode" in e ? e.statusCode : undefined);
    const b =
      e instanceof BridgeError
        ? e
        : new BridgeError(
            status === 404
              ? "NOT_FOUND"
              : status === 400
                ? "INVALID_REQUEST"
                : "REQUEST_FAILED",
            [400, 404, 413].includes(status) ? status : 502,
          );
    console.error(
      JSON.stringify({
        event: "request_failed",
        code: b.code,
        status: b.status,
        route: req.routeOptions.url ?? "unknown",
      }),
    );
    reply.code(b.status).send({
      error: {
        code: b.code,
        message:
          b.status === 401
            ? "Pair your device again."
            : b.status === 403
              ? "This workspace is not permitted."
              : b.status === 409
                ? "This action has changed. Refresh and check the conversation."
                : "The request could not be completed. Check your computer.",
        retryable: b.retryable,
        requestId: randomUUID(),
      },
    });
  };
  remote.setErrorHandler(error);
  admin.setErrorHandler(error);
  const envelope = (data: unknown, cursor: string | null = null) => {
    const result = { data, cursor };
    if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024)
      throw new BridgeError("SNAPSHOT_TOO_LARGE", 413);
    return result;
  };
  const body = (v: unknown, keys: string[]) => {
    if (!record(v) || Object.keys(v).some((k) => !keys.includes(k)))
      throw new BridgeError("INVALID_REQUEST", 400);
    return v;
  };
  const requestId = (v: unknown) => {
    const b = body(v, ["requestId"]);
    if (
      typeof b.requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        b.requestId,
      )
    )
      throw new BridgeError("INVALID_REQUEST", 400);
    return b.requestId;
  };
  const token = (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) throw new BridgeError("UNAUTHORIZED", 401);
    return h.slice(7);
  };
  const device = (req: FastifyRequest) => {
    const d = devices.get(req);
    if (!d) throw new BridgeError("UNAUTHORIZED", 401);
    return d;
  };
  const scope = (req: FastifyRequest, wid: string) => {
    const d = device(req);
    if (!d.allWorkspaces && !d.workspaceIds.includes(wid))
      throw new BridgeError("FORBIDDEN", 403);
    return d;
  };
  const session = async (req: FastifyRequest, wid: string, sid: string) => {
    scope(req, wid);
    const s = await o.adapter.readSession(wid, sid);
    if (s.workspaceId !== wid || s.id !== sid)
      throw new BridgeError("NOT_FOUND", 404);
    return s;
  };
  remote.addHook("onRequest", async (req, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff");
    if (req.headers.origin) throw new BridgeError("FORBIDDEN", 403);
    if (
      req.url.startsWith("/v1/") &&
      !["/v1/pairings/claim", "/v1/pairings/poll", "/v1/pairings/ack"].includes(
        req.url.split("?")[0]!,
      )
    )
      devices.set(req, o.pairing.authenticate(token(req)));
  });
  remote.post("/v1/pairings/claim", async (req) => {
    const b = body(req.body, [
      "pairingId",
      "secret",
      "deviceId",
      "deviceName",
      "protocolVersion",
    ]);
    return envelope(o.pairing.claim(b as any, req.ip));
  });
  remote.post("/v1/pairings/poll", async (req) => {
    const b = body(req.body, ["claimId", "pollToken"]);
    if (typeof b.claimId !== "string" || typeof b.pollToken !== "string")
      throw new BridgeError("INVALID_REQUEST", 400);
    const p = o.pairing.poll(b.claimId, b.pollToken);
    return envelope({
      ...p,
      ...(p.state === "approved" ? { host: host() } : {}),
    });
  });
  remote.post("/v1/pairings/ack", async (req, reply) => {
    await o.pairing.ack(token(req));
    return reply.code(204).send();
  });
  remote.get("/v1/host", async () => {
    await o.adapter.health();
    return envelope(host());
  });
  remote.get("/v1/device/access", async (req) =>
    envelope({
      allWorkspaces: device(req).allWorkspaces ?? false,
      workspaceIds: device(req).workspaceIds,
    }),
  );
  remote.get("/v1/workspaces", async (req) =>
    envelope(
      (await o.adapter.listWorkspaces()).filter(
        (w) =>
          device(req).allWorkspaces || device(req).workspaceIds.includes(w.id),
      ),
    ),
  );
  remote.get<{ Params: { wid: string }; Querystring: { cursor?: string } }>(
    "/v1/workspaces/:wid/sessions",
    async (req) => {
      scope(req, req.params.wid);
      const page = await o.adapter.listSessions(
        req.params.wid,
        req.query.cursor,
      );
      return envelope(page.data, page.cursor);
    },
  );
  remote.get<{ Params: { wid: string; sid: string } }>(
    "/v1/workspaces/:wid/sessions/:sid",
    async (req) => envelope(await session(req, req.params.wid, req.params.sid)),
  );
  remote.get<{
    Params: { wid: string; sid: string };
    Querystring: { cursor?: string };
  }>("/v1/workspaces/:wid/sessions/:sid/messages", async (req) => {
    const { wid, sid } = req.params;
    await session(req, wid, sid);
    const page = await o.adapter.readMessages(wid, sid, req.query.cursor);
    return envelope(page.data, page.cursor);
  });
  remote.post<{ Params: { wid: string; sid: string } }>(
    "/v1/workspaces/:wid/sessions/:sid/rename",
    async (req) => {
      const { wid, sid } = req.params;
      await session(req, wid, sid);
      if (!o.adapter.capabilities.renameSession)
        throw new BridgeError("UNSUPPORTED_ACTION", 422);
      const b = body(req.body, ["requestId", "title", "previousTitle"]);
      const id = requestId({ requestId: b.requestId });
      if (typeof b.title !== "string" || !b.title.trim() ||
          Array.from(b.title.trim()).length > 200 ||
          typeof b.previousTitle !== "string" || Array.from(b.previousTitle).length > 4096)
        throw new BridgeError("INVALID_REQUEST", 400);
      const title = b.title.trim(), previousTitle = b.previousTitle;
      return envelope(await ledger.perform(device(req).id, id, req.url,
        { wid, sid, title, previousTitle }, async () => {
          await o.adapter.rename(wid, sid, title, previousTitle);
          return sid;
        }));
    },
  );
  remote.get<{ Params: { wid: string; sid: string } }>(
    "/v1/workspaces/:wid/sessions/:sid/status",
    async (req) => {
      const { wid, sid } = req.params;
      await session(req, wid, sid);
      return envelope(await o.adapter.readStatus(wid, sid));
    },
  );
  remote.get<{ Params: { wid: string; sid: string } }>(
    "/v1/workspaces/:wid/sessions/:sid/approvals",
    async (req) => {
      const { wid, sid } = req.params;
      await session(req, wid, sid);
      return envelope(await o.adapter.readApprovals(wid, sid));
    },
  );
  remote.post<{ Params: { wid: string } }>(
    "/v1/workspaces/:wid/sessions",
    async (req) => {
      const { wid } = req.params,
        d = scope(req, wid),
        id = requestId(req.body);
      if (!o.adapter.capabilities.createSession)
        throw new BridgeError("UNSUPPORTED_ACTION", 422);
      return envelope(
        await ledger.perform(d.id, id, req.routeOptions.url!, { wid }, () =>
          o.adapter.create(wid),
        ),
      );
    },
  );
  remote.post<{ Params: { wid: string; sid: string } }>(
    "/v1/workspaces/:wid/sessions/:sid/messages",
    async (req) => {
      const { wid, sid } = req.params;
      await session(req, wid, sid);
      const b = parseSend(req.body);
      if (!o.adapter.capabilities.sendText)
        throw new BridgeError("UNSUPPORTED_ACTION", 422);
      return envelope(
        await ledger.perform(
          device(req).id,
          b.requestId,
          req.url,
          { wid, sid, text: b.text },
          async () => {
            await o.adapter.send(wid, sid, b.text);
            return sid;
          },
        ),
      );
    },
  );
  remote.post<{ Params: { wid: string; sid: string } }>(
    "/v1/workspaces/:wid/sessions/:sid/stop",
    async (req) => {
      const { wid, sid } = req.params;
      await session(req, wid, sid);
      const id = requestId(req.body);
      if (!o.adapter.capabilities.stop)
        throw new BridgeError("UNSUPPORTED_ACTION", 422);
      return envelope(
        await ledger.perform(
          device(req).id,
          id,
          req.url,
          { wid, sid },
          async () => {
            await o.adapter.stop(wid, sid);
            return sid;
          },
        ),
      );
    },
  );
  remote.post<{ Params: { wid: string; sid: string; aid: string } }>(
    "/v1/workspaces/:wid/sessions/:sid/approvals/:aid/reply",
    async (req) => {
      const { wid, sid, aid } = req.params;
      await session(req, wid, sid);
      const b = parseApprovalReply(req.body);
      if (!o.adapter.capabilities.replyApproval)
        throw new BridgeError("UNSUPPORTED_ACTION", 422);
      return envelope(
        await ledger.perform(
          device(req).id,
          b.requestId,
          req.url,
          { wid, sid, aid, decision: b.decision, revision: b.revision },
          async () => {
            await o.adapter.reply(wid, sid, aid, b.decision, b.revision);
            return aid;
          },
        ),
      );
    },
  );
  const revision = (value: unknown) => {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
      throw new BridgeError("INVALID_REQUEST", 400);
    return value;
  };
  remote.get<{ Params: { wid: string; sid: string } }>(
    "/v1/workspaces/:wid/sessions/:sid/model-settings",
    async (req) => {
      const { wid, sid } = req.params;
      await session(req, wid, sid);
      return envelope(await o.adapter.readModelSettings(wid, sid));
    },
  );
  remote.post<{ Params: { wid: string; sid: string } }>(
    "/v1/workspaces/:wid/sessions/:sid/model-settings",
    async (req) => {
      const { wid, sid } = req.params;
      await session(req, wid, sid);
      const b = body(req.body, ["requestId", "revision", "model"]),
        m = body(b.model, ["providerId", "modelId", "variant"]);
      const id = requestId({ requestId: b.requestId }),
        rev = revision(b.revision);
      if (
        typeof m.providerId !== "string" ||
        !m.providerId.length ||
        m.providerId.length > 200 ||
        typeof m.modelId !== "string" ||
        !m.modelId.length ||
        m.modelId.length > 200 ||
        (m.variant !== null &&
          (typeof m.variant !== "string" ||
            !m.variant.length ||
            m.variant.length > 80))
      )
        throw new BridgeError("INVALID_REQUEST", 400);
      const model = {
        providerId: m.providerId,
        modelId: m.modelId,
        variant: m.variant as string | null,
      };
      return envelope(
        await ledger.perform(
          device(req).id,
          id,
          req.url,
          { wid, sid, model, revision: rev },
          async () => {
            await o.adapter.setModel(wid, sid, model, rev);
            return sid;
          },
        ),
      );
    },
  );
  remote.get<{ Params: { wid: string; sid: string } }>(
    "/v1/workspaces/:wid/sessions/:sid/permissions",
    async (req) => {
      const { wid, sid } = req.params;
      await session(req, wid, sid);
      return envelope(await o.adapter.readSavedPermissions(wid, sid));
    },
  );
  remote.post<{ Params: { wid: string; sid: string; pid: string } }>(
    "/v1/workspaces/:wid/sessions/:sid/permissions/:pid/revoke",
    async (req) => {
      const { wid, sid, pid } = req.params;
      await session(req, wid, sid);
      const b = body(req.body, ["requestId", "revision"]),
        id = requestId({ requestId: b.requestId }),
        rev = revision(b.revision);
      return envelope(
        await ledger.perform(
          device(req).id,
          id,
          req.url,
          { wid, sid, pid, revision: rev },
          async () => {
            await o.adapter.revokeSavedPermission(wid, sid, pid, rev);
            return pid;
          },
        ),
      );
    },
  );
  remote.get("/v1/events", async (req, reply) => {
    if (!o.adapter.capabilities.events)
      throw new BridgeError("UNSUPPORTED_ACTION", 422);
    const d = device(req),
      credential = token(req);
    const active = streams.get(d.id) ?? new Set<() => void>();
    if (active.size >= 4) throw new BridgeError("RATE_LIMITED", 429);
    streams.set(d.id, active);
    // An authenticated foreground event stream outlives the ordinary HTTP request timeout.
    // Heartbeats and bounded queues still enforce its application-level lifecycle.
    req.raw.socket.setTimeout(0);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.flushHeaders();
    let closed = false;
    let timer: NodeJS.Timeout;
    let remove = () => {};
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      remove();
      active.delete(close);
      reply.raw.end();
    };
    const write = (event: { id?: string; event: string; data: unknown }) => {
      if (closed) return;
      try {
        const current = o.pairing.authenticate(credential);
        const wid = (event.data as any).workspaceId;
        if (
          wid &&
          !current.allWorkspaces &&
          !current.workspaceIds.includes(wid)
        )
          return;
        const bytes = `${event.id ? "id: " + event.id + "\n" : ""}event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
        if (
          reply.raw.writableLength + Buffer.byteLength(bytes) >
          2 * 1024 * 1024
        ) {
          close();
          return;
        }
        reply.raw.write(bytes);
      } catch {
        close();
      }
    };
    active.add(close);
    remove = hub.add(write);
    req.raw.on("close", close);
    reply.raw.on("close", close);
    timer = setInterval(
      () => write({ event: "heartbeat", data: { kind: "hostChanged" } }),
      15000,
    );
    timer.unref();
    const replay = hub.buffer.replay(
      typeof req.headers["last-event-id"] === "string"
        ? req.headers["last-event-id"]
        : undefined,
      d.workspaceIds,
      d.allWorkspaces,
    );
    if (replay.reset) write({ event: "reset", data: { kind: "hostChanged" } });
    else for (const e of replay.events) write(e);
  });
  remote.delete("/v1/device", async (req, reply) => {
    const id = device(req).id;
    await o.pairing.revoke(id);
    for (const close of streams.get(id) ?? []) close();
    streams.delete(id);
    return reply.code(204).send();
  });
  admin.addHook("onRequest", async (req, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    const h = req.headers.host;
    if (h !== "127.0.0.1:9289" && h !== "localhost:9289")
      throw new BridgeError("FORBIDDEN", 403);
    if (req.headers.origin && req.headers.origin !== `http://${h}`)
      throw new BridgeError("FORBIDDEN", 403);
    if (req.headers["sec-fetch-site"] === "cross-site")
      throw new BridgeError("FORBIDDEN", 403);
    if (req.url.startsWith("/admin/")) {
      if (req.headers.cookie !== `owr_admin=${adminSession}`)
        throw new BridgeError("FORBIDDEN", 403);
      if (
        req.method !== "GET" &&
        (req.headers.origin !== `http://${h}` ||
          req.headers["x-admin-session"] !== adminSession)
      )
        throw new BridgeError("FORBIDDEN", 403);
    }
  });
  admin.get("/", async (_req, reply) =>
    reply
      .header(
        "Set-Cookie",
        `owr_admin=${adminSession}; HttpOnly; SameSite=Strict; Path=/`,
      )
      .type("text/html")
      .send(adminHTML),
  );
  admin.get("/admin.js", async (_req, reply) =>
    reply.type("text/javascript").send(adminJS),
  );
  admin.get("/admin.css", async (_req, reply) =>
    reply.type("text/css").send(adminCSS),
  );
  admin.get("/admin/state", async () =>
    envelope({ ...(await controls.state()), csrf: adminSession }),
  );
  admin.post("/admin/pairings", async () => envelope(await controls.pair()));
  admin.post<{ Params: { id: string } }>(
    "/admin/claims/:id/approve",
    async (req) => envelope(await controls.approve(req.params.id, req.body)),
  );
  admin.post<{ Params: { id: string } }>(
    "/admin/devices/:id/access",
    async (req) => envelope(await controls.access(req.params.id, req.body)),
  );
  admin.post<{ Params: { id: string } }>(
    "/admin/claims/:id/deny",
    async (req) => envelope(await controls.deny(req.params.id)),
  );
  admin.post<{ Params: { id: string } }>(
    "/admin/devices/:id/revoke",
    async (req) => envelope(await controls.revoke(req.params.id)),
  );
  return { remote, admin, host, streams, token, hub, controls };
}
