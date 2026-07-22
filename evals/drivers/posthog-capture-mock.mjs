#!/usr/bin/env node
/**
 * Tiny PostHog capture mock.
 *
 * Usage:
 *   node evals/drivers/posthog-capture-mock.mjs --port 19877
 *   LANDING_POSTHOG_HOST=http://127.0.0.1:19877 pnpm --dir ee/apps/landing dev
 */

import { createServer } from "node:http";

const DEFAULT_PORT = 19877;
const events = [];

function selectedPort() {
  const index = process.argv.indexOf("--port");
  const value = index === -1 ? process.env.POSTHOG_MOCK_PORT : process.argv[index + 1];
  return Number(value ?? DEFAULT_PORT);
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

function readJson(request, response) {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) request.destroy();
  });
  request.on("end", () => {
    try {
      events.push(body ? JSON.parse(body) : {});
      sendJson(response, 200, { status: 1 });
    } catch {
      sendJson(response, 400, { status: 0, error: "invalid_json" });
    }
  });
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const method = request.method ?? "GET";

  if (method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  if (url.pathname === "/i/v0/e/" && method === "POST") {
    readJson(request, response);
    return;
  }

  if (url.pathname === "/events" && method === "GET") {
    sendJson(response, 200, events);
    return;
  }

  if (url.pathname === "/events" && method === "DELETE") {
    events.length = 0;
    sendJson(response, 200, { status: 1 });
    return;
  }

  sendJson(response, 404, { status: 0, error: "not_found" });
});

const port = selectedPort();

if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid port: ${port}`);
}

server.listen(port, "127.0.0.1", () => {
  console.log(`PostHog capture mock listening at http://127.0.0.1:${port}`);
});
