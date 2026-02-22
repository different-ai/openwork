import http from "node:http";

import type { Logger } from "pino";

export type HealthSnapshot = {
  ok: boolean;
  opencode: {
    url: string;
    healthy: boolean;
    version?: string;
  };
  channels: {
    telegram: boolean;
    whatsapp: boolean;
    slack: boolean;
  };
  config: {
    groupsEnabled: boolean;
  };
  activity?: {
    dayStart: number;
    inboundToday: number;
    outboundToday: number;
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastMessageAt?: number;
  };
  agent?: {
    scope: "workspace";
    path: string;
    loaded: boolean;
    selected?: string;
  };
};

export type GroupsConfigResult = {
  groupsEnabled: boolean;
};

export type TelegramIdentityItem = {
  id: string;
  enabled: boolean;
  running: boolean;
  access?: "public" | "private";
  pairingRequired?: boolean;
};

export type SlackIdentityItem = {
  id: string;
  enabled: boolean;
  running: boolean;
};

export type TelegramIdentitiesResult = {
  items: TelegramIdentityItem[];
};

export type SlackIdentitiesResult = {
  items: SlackIdentityItem[];
};

export type UpsertIdentityResult = {
  id: string;
  enabled: boolean;
  access?: "public" | "private";
  pairingRequired?: boolean;
  applied?: boolean;
  starting?: boolean;
  error?: string;
};

export type DeleteIdentityResult = {
  id: string;
  deleted: boolean;
  applied?: boolean;
  starting?: boolean;
  error?: string;
};

export type TelegramIdentityUpsertInput = {
  id?: string;
  token: string;
  enabled?: boolean;
  directory?: string;
  access?: "public" | "private";
  pairingCodeHash?: string;
};

export type SlackIdentityUpsertInput = {
  id?: string;
  botToken: string;
  appToken: string;
  enabled?: boolean;
  directory?: string;
};

export type BindingItem = {
  channel: string;
  identityId: string;
  peerId: string;
  directory: string;
  updatedAt?: number;
};

export type BindingsListResult = {
  items: BindingItem[];
};

export type SendMessageInput = {
  channel: string;
  identityId?: string;
  directory?: string;
  peerId?: string;
  autoBind?: boolean;
  text: string;
};

export type SendMessageResult = {
  channel: string;
  directory: string;
  identityId?: string;
  peerId?: string;
  attempted: number;
  sent: number;
  failures?: Array<{ identityId: string; peerId: string; error: string }>;
  reason?: string;
};

export type HealthHandlers = {
  setGroupsEnabled?: (enabled: boolean) => Promise<GroupsConfigResult>;
  getGroupsEnabled?: () => boolean;
  listTelegramIdentities?: () => Promise<TelegramIdentitiesResult>;
  upsertTelegramIdentity?: (input: TelegramIdentityUpsertInput) => Promise<UpsertIdentityResult>;
  deleteTelegramIdentity?: (id: string) => Promise<DeleteIdentityResult>;
  listSlackIdentities?: () => Promise<SlackIdentitiesResult>;
  upsertSlackIdentity?: (input: SlackIdentityUpsertInput) => Promise<UpsertIdentityResult>;
  deleteSlackIdentity?: (id: string) => Promise<DeleteIdentityResult>;
  listBindings?: (filters?: { channel?: string; identityId?: string }) => Promise<BindingsListResult>;
  setBinding?: (input: { channel: string; identityId?: string; peerId: string; directory: string }) => Promise<void>;
  clearBinding?: (input: { channel: string; identityId?: string; peerId: string }) => Promise<void>;
  sendMessage?: (input: SendMessageInput) => Promise<SendMessageResult>;
};

export async function startHealthServer(
  port: number,
  getStatus: () => HealthSnapshot,
  logger: Logger,
  handlers: HealthHandlers = {},
) {
  const server = http.createServer((req, res) => {
    void (async () => {
      const requestOrigin = req.headers.origin;
      if (requestOrigin) {
        res.setHeader("Access-Control-Allow-Origin", requestOrigin);
        res.setHeader("Vary", "Origin");
      } else {
        res.setHeader("Access-Control-Allow-Origin", "*");
      }
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");

      const requestHeaders = req.headers["access-control-request-headers"];
      if (Array.isArray(requestHeaders)) {
        res.setHeader("Access-Control-Allow-Headers", requestHeaders.join(", "));
      } else if (typeof requestHeaders === "string" && requestHeaders.trim()) {
        res.setHeader("Access-Control-Allow-Headers", requestHeaders);
      } else {
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      }

      if (req.headers["access-control-request-private-network"] === "true") {
        res.setHeader("Access-Control-Allow-Private-Network", "true");
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const pathname = req.url ? new URL(req.url, "http://localhost").pathname : "";

      if (!pathname || pathname === "/" || pathname === "/health") {
        const snapshot = getStatus();
        res.writeHead(snapshot.ok ? 200 : 503, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(snapshot));
        return;
      }

      // Legacy alias: POST /config/telegram-token -> upsert telegram identity "default".
      if (pathname === "/config/telegram-token" && req.method === "POST") {
        if (!handlers.upsertTelegramIdentity) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not supported" }));
          return;
        }

        let raw = "";
        for await (const chunk of req) {
          raw += chunk.toString();
          if (raw.length > 1024 * 1024) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Payload too large" }));
            return;
          }
        }

        try {
          const payload = JSON.parse(raw || "{}");
          const token = typeof payload.token === "string" ? payload.token.trim() : "";
          if (!token) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Token is required" }));
            return;
          }
          const result = await handlers.upsertTelegramIdentity({ id: "default", token, enabled: true });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, telegram: result }));
          return;
        } catch (error) {
          const statusRaw = (error as any)?.status;
          const status = typeof statusRaw === "number" && statusRaw >= 400 && statusRaw < 600 ? statusRaw : 500;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(error instanceof Error ? error.message : error) }));
          return;
        }
      }

      // Legacy alias: POST /config/slack-tokens -> upsert slack identity "default".
      if (pathname === "/config/slack-tokens" && req.method === "POST") {
        if (!handlers.upsertSlackIdentity) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not supported" }));
          return;
        }

        let raw = "";
        for await (const chunk of req) {
          raw += chunk.toString();
          if (raw.length > 1024 * 1024) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Payload too large" }));
            return;
          }
        }

        try {
          const payload = JSON.parse(raw || "{}");
          const botToken = typeof payload.botToken === "string" ? payload.botToken.trim() : "";
          const appToken = typeof payload.appToken === "string" ? payload.appToken.trim() : "";
          if (!botToken || !appToken) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Slack botToken and appToken are required" }));
            return;
          }
          const result = await handlers.upsertSlackIdentity({ id: "default", botToken, appToken, enabled: true });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, slack: result }));
          return;
        } catch (error) {
          const statusRaw = (error as any)?.status;
          const status = typeof statusRaw === "number" && statusRaw >= 400 && statusRaw < 600 ? statusRaw : 500;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(error instanceof Error ? error.message : error) }));
          return;
        }
      }

      // GET /identities/telegram
      if (pathname === "/identities/telegram" && req.method === "GET") {
        if (!handlers.listTelegramIdentities) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not supported" }));
          return;
        }
        try {
          const result = await handlers.listTelegramIdentities();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...result }));
          return;
        } catch (error) {
          const statusRaw = (error as any)?.status;
          const status = typeof statusRaw === "number" && statusRaw >= 400 && statusRaw < 600 ? statusRaw : 500;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(error instanceof Error ? error.message : error) }));
          return;
        }
      }

      // POST /identities/telegram
      if (pathname === "/identities/telegram" && req.method === "POST") {
        if (!handlers.upsertTelegramIdentity) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not supported" }));
          return;
        }
        let raw = "";
        for await (const chunk of req) {
          raw += chunk.toString();
          if (raw.length > 1024 * 1024) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Payload too large" }));
            return;
          }
        }
        try {
          const payload = JSON.parse(raw || "{}");
          const token = typeof payload.token === "string" ? payload.token.trim() : "";
          const id = typeof payload.id === "string" ? payload.id.trim() : undefined;
          const directory = typeof payload.directory === "string" ? payload.directory.trim() : undefined;
          const access = typeof payload.access === "string" ? payload.access.trim() : undefined;
          const pairingCodeHash = typeof payload.pairingCodeHash === "string" ? payload.pairingCodeHash.trim() : undefined;
          const enabled = payload.enabled === undefined ? undefined : payload.enabled === true || payload.enabled === "true";
          if (!token) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "token is required" }));
            return;
          }
          const result = await handlers.upsertTelegramIdentity({
            id,
            token,
            ...(enabled === undefined ? {} : { enabled }),
            ...(directory ? { directory } : {}),
            ...(access ? { access: access as "public" | "private" } : {}),
            ...(pairingCodeHash ? { pairingCodeHash } : {}),
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, telegram: result }));
          return;
        } catch (error) {
          const statusRaw = (error as any)?.status;
          const status = typeof statusRaw === "number" && statusRaw >= 400 && statusRaw < 600 ? statusRaw : 500;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(error instanceof Error ? error.message : error) }));
          return;
        }
      }

      // DELETE /identities/telegram/:id
      if (pathname.startsWith("/identities/telegram/") && req.method === "DELETE") {
        if (!handlers.deleteTelegramIdentity) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not supported" }));
          return;
        }
        const id = pathname.slice("/identities/telegram/".length).trim();
        if (!id) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "id is required" }));
          return;
        }
        try {
          const result = await handlers.deleteTelegramIdentity(id);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, telegram: result }));
          return;
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(error) }));
          return;
        }
      }

      // GET /identities/slack
      if (pathname === "/identities/slack" && req.method === "GET") {
        if (!handlers.listSlackIdentities) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not supported" }));
          return;
        }
        try {
          const result = await handlers.listSlackIdentities();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...result }));
          return;
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(error) }));
          return;
        }
      }

      // POST /identities/slack
      if (pathname === "/identities/slack" && req.method === "POST") {
        if (!handlers.upsertSlackIdentity) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not supported" }));
          return;
        }
        let raw = "";
        for await (const chunk of req) {
          raw += chunk.toString();
          if (raw.length > 1024 * 1024) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Payload too large" }));
            return;
          }
        }
        try {
          const payload = JSON.parse(raw || "{}");
          const botToken = typeof payload.botToken === "string" ? payload.botToken.trim() : "";
          const appToken = typeof payload.appToken === "string" ? payload.appToken.trim() : "";
          const id = typeof payload.id === "string" ? payload.id.trim() : undefined;
          const directory = typeof payload.directory === "string" ? payload.directory.trim() : undefined;
          const enabled = payload.enabled === undefined ? undefined : payload.enabled === true || payload.enabled === "true";
          if (!botToken || !appToken) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "botToken and appToken are required" }));
            return;
          }
          const result = await handlers.upsertSlackIdentity({
            id,
            botToken,
            appToken,
            ...(enabled === undefined ? {} : { enabled }),
            ...(directory ? { directory } : {}),
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, slack: result }));
          return;
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(error) }));
          return;
        }
      }

      // DELETE /identities/slack/:id
      if (pathname.startsWith("/identities/slack/") && req.method === "DELETE") {
        if (!handlers.deleteSlackIdentity) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not supported" }));
          return;
        }
        const id = pathname.slice("/identities/slack/".length).trim();
        if (!id) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "id is required" }));
          return;
        }
        try {
          const result = await handlers.deleteSlackIdentity(id);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, slack: result }));
          return;
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(error) }));
          return;
        }
      }

      // GET /config/groups - get current groups setting
      if (pathname === "/config/groups" && req.method === "GET") {
        if (!handlers.getGroupsEnabled) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not supported" }));
          return;
        }

        const groupsEnabled = handlers.getGroupsEnabled();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, groupsEnabled }));
        return;
      }

      // POST /config/groups - set groups enabled
      if (pathname === "/config/groups" && req.method === "POST") {
        if (!handlers.setGroupsEnabled) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not supported" }));
          return;
        }

        let raw = "";
        for await (const chunk of req) {
          raw += chunk.toString();
          if (raw.length > 1024 * 1024) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Payload too large" }));
            return;
          }
        }

        try {
          const payload = JSON.parse(raw || "{}");
          const enabled = payload.enabled === true || payload.enabled === "true";

          const result = await handlers.setGroupsEnabled(enabled);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...result }));
          return;
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(error) }));
          return;
        }
      }

      if (pathname === "/bindings" && req.method === "GET") {
        if (!handlers.listBindings) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not supported" }));
          return;
        }

        try {
          const parsed = req.url ? new URL(req.url, "http://localhost") : null;
          const channel = typeof parsed?.searchParams.get("channel") === "string" ? parsed?.searchParams.get("channel") ?? undefined : undefined;
          const identityId = typeof parsed?.searchParams.get("identityId") === "string" ? parsed?.searchParams.get("identityId") ?? undefined : undefined;
          const result = await handlers.listBindings({
            ...(channel?.trim() ? { channel: channel.trim() } : {}),
            ...(identityId?.trim() ? { identityId: identityId.trim() } : {}),
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...result }));
          return;
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(error) }));
          return;
        }
      }

      if (pathname === "/bindings" && req.method === "POST") {
        if (!handlers.setBinding && !handlers.clearBinding) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not supported" }));
          return;
        }

        let raw = "";
        for await (const chunk of req) {
          raw += chunk.toString();
          if (raw.length > 1024 * 1024) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Payload too large" }));
            return;
          }
        }

        try {
          const payload = JSON.parse(raw || "{}");
          const channel = typeof payload.channel === "string" ? payload.channel.trim() : "";
          const identityId = typeof payload.identityId === "string" ? payload.identityId.trim() : "";
          const peerId = typeof payload.peerId === "string" ? payload.peerId.trim() : "";
          const directory = typeof payload.directory === "string" ? payload.directory.trim() : "";

          if (!channel || !peerId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "channel and peerId are required" }));
            return;
          }

          if (!directory) {
            if (!handlers.clearBinding) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "Not supported" }));
              return;
            }
            await handlers.clearBinding({ channel, identityId: identityId || undefined, peerId });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          if (!handlers.setBinding) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Not supported" }));
            return;
          }
          await handlers.setBinding({ channel, identityId: identityId || undefined, peerId, directory });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(error) }));
          return;
        }
      }

      if (pathname === "/send" && req.method === "POST") {
        if (!handlers.sendMessage) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not supported" }));
          return;
        }

        let raw = "";
        for await (const chunk of req) {
          raw += chunk.toString();
          if (raw.length > 1024 * 1024) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Payload too large" }));
            return;
          }
        }

        try {
          const payload = JSON.parse(raw || "{}");
          const channel = typeof payload.channel === "string" ? payload.channel.trim() : "";
          const identityId = typeof payload.identityId === "string" ? payload.identityId.trim() : "";
          const directory = typeof payload.directory === "string" ? payload.directory.trim() : "";
          const peerId = typeof payload.peerId === "string" ? payload.peerId.trim() : "";
          const autoBind = payload.autoBind === true;
          const text = typeof payload.text === "string" ? payload.text : "";
          if (!channel || !text.trim() || (!directory && !peerId)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "channel, text, and either directory or peerId are required" }));
            return;
          }

          const result = await handlers.sendMessage({
            channel,
            ...(identityId ? { identityId } : {}),
            ...(directory ? { directory } : {}),
            ...(peerId ? { peerId } : {}),
            ...(autoBind ? { autoBind: true } : {}),
            text,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...result }));
          return;
        } catch (error) {
          const statusRaw = (error as any)?.status;
          const status = typeof statusRaw === "number" && statusRaw >= 400 && statusRaw < 600 ? statusRaw : 500;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(error instanceof Error ? error.message : error) }));
          return;
        }
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Not found" }));
    })().catch((error) => {
      logger.error({ error }, "health server request failed");
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Internal error" }));
    });
  });

  const host = (process.env.OPENCODE_ROUTER_HEALTH_HOST ?? "").trim() || "127.0.0.1";

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EADDRINUSE") {
      throw new Error(
        `Failed to start health server on ${host}:${port}. Port is in use. ` +
          `Set OPENCODE_ROUTER_HEALTH_PORT, OPENCODE_ROUTER_HEALTH_PORT, or PORT to a free port.`,
      );
    }
    throw error;
  }

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  logger.info({ host, port: actualPort }, "health server listening");

  return () => {
    server.close();
  };
}
