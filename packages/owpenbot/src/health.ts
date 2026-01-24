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
  };
};

export function startHealthServer(
  port: number,
  getStatus: () => HealthSnapshot,
  logger: Logger,
) {
  const server = http.createServer((req, res) => {
    if (!req.url || req.url === "/health") {
      const snapshot = getStatus();
      res.writeHead(snapshot.ok ? 200 : 503, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(snapshot));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Not found" }));
  });

  server.listen(port, "127.0.0.1", () => {
    logger.info({ port }, "health server listening");
  });

  return () => {
    server.close();
  };
}
