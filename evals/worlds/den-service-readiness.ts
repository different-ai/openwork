import { createServer } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { once } from "node:events";
import type { Seed } from "@openwork/env";

const TOKEN = "readiness-fixture-service-token-not-production";
export const SMTP_FIXTURE_USER = "readiness-fixture-smtp-user";
export const SMTP_FIXTURE_PASS = "readiness-fixture-smtp-pass-not-production";

/** Only service health is mocked. Den authentication, routes, snapshots and UI are real. */
export async function healthFixture() {
  let calls = 0;
  let unauthorized = 0;
  let unexpected = 0;
  const server = createServer((request, response) => {
    calls++;
    if (request.method !== "GET" || !["/health", "/ready", "/v1/health", "/internal/readiness"].includes(request.url ?? "")) unexpected++;
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    if (request.url === "/health") return void response.end(JSON.stringify({ ok: true, service: "gateway" }));
    if (request.url === "/ready") return void response.end(JSON.stringify({ ok: true, service: "gateway", checks: { database: "ok" } }));
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      unauthorized++;
      response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (request.url === "/v1/health") return void response.end(JSON.stringify({ version: 1, service: "headless-runner", modelConfigured: true, resumeConfigured: false, denOriginMatches: null }));
    if (request.url === "/internal/readiness") return void response.end(JSON.stringify({ version: 1, service: "workbot", runnerConfigured: true, denOriginMatches: Boolean(request.headers["x-openwork-den-origin"]) }));
    response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing readiness fixture port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls: () => calls,
    unauthorized: () => unauthorized,
    unexpected: () => unexpected,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

/**
 * A minimal plaintext SMTP server. It accepts EHLO and AUTH PLAIN/LOGIN for the
 * fixture account and records each connection's commands, so a proof can show
 * the readiness check signed in and quit without starting a message (no MAIL,
 * RCPT or DATA). Other Den mail on separate connections is accepted.
 */
export async function smtpFixture() {
  const sessions: string[][] = [];
  let signedIn = 0;
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    const commands: string[] = [];
    sessions.push(commands);
    let buffer = "";
    let pendingLogin: "user" | "pass" | null = null;
    let loginUser = "";
    let inData = false;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply("220 readiness-fixture ESMTP");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\r\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\r\n");
        // Other Den mail (sign-up, invitations) may legitimately use this server; accept and discard it.
        if (inData) { if (line === ".") { inData = false; reply("250 2.0.0 Accepted"); } continue; }
        if (pendingLogin === "user") { loginUser = Buffer.from(line, "base64").toString("utf8"); pendingLogin = "pass"; reply("334 UGFzc3dvcmQ6"); continue; }
        if (pendingLogin === "pass") {
          pendingLogin = null;
          const ok = loginUser === SMTP_FIXTURE_USER && Buffer.from(line, "base64").toString("utf8") === SMTP_FIXTURE_PASS;
          if (ok) signedIn++;
          reply(ok ? "235 2.7.0 Authentication successful" : "535 5.7.8 Authentication failed");
          continue;
        }
        const verb = line.split(" ")[0]?.toUpperCase() ?? "";
        commands.push(verb);
        if (verb === "EHLO" || verb === "HELO") { socket.write("250-readiness-fixture\r\n250 AUTH PLAIN LOGIN\r\n"); continue; }
        if (verb === "AUTH") {
          const [, mechanism, initial] = line.split(" ");
          if (mechanism?.toUpperCase() === "PLAIN") {
            const [, user, pass] = Buffer.from(initial ?? "", "base64").toString("utf8").split("\u0000");
            const ok = user === SMTP_FIXTURE_USER && pass === SMTP_FIXTURE_PASS;
            if (ok) signedIn++;
            reply(ok ? "235 2.7.0 Authentication successful" : "535 5.7.8 Authentication failed");
          } else { pendingLogin = "user"; reply("334 VXNlcm5hbWU6"); }
          continue;
        }
        if (verb === "QUIT") { reply("221 Bye"); socket.end(); continue; }
        if (verb === "RSET" || verb === "NOOP" || verb === "MAIL" || verb === "RCPT") { reply("250 OK"); continue; }
        if (verb === "DATA") { inData = true; reply("354 End data with <CR><LF>.<CR><LF>"); continue; }
        reply("502 Command not implemented");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing SMTP fixture port");
  return {
    host: "127.0.0.1",
    port: address.port,
    /** Commands per SMTP connection, in order. */
    sessions: () => sessions.map((commands) => [...commands]),
    signedIn: () => signedIn,
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export function denServicesWithoutInfrastructure(seed: Seed) { return readinessWorld(seed, false); }
export function denServicesWithInfrastructure(seed: Seed) { return readinessWorld(seed, true); }

async function readinessWorld(seed: Seed, configured: boolean) {
  const stack = new AsyncDisposableStack();
  try {
    const fixture = stack.use(await healthFixture());
    const smtp = stack.use(await smtpFixture());
    const den = await seed.den({
      org: { name: "Service checks", admin: { name: "Deployment Administrator" }, members: { member: { name: "Workspace Member" } } },
      env: {
        DEN_DEPLOYMENT: "self_hosted",
        GATEWAY_ENABLED: configured ? "true" : "false",
        GATEWAY_PROXY_BASE_URL: configured ? fixture.url : "",
        GATEWAY_PUBLIC_BASE_URL: configured ? fixture.url : "",
        DEN_HEADLESS_RUNNER_URL: configured ? fixture.url : "",
        DEN_HEADLESS_RUNNER_TOKEN: configured ? TOKEN : "",
        DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: "", DEN_WORKBOT_URL: configured ? fixture.url : "",
        SMTP_HOST: configured ? smtp.host : "",
        SMTP_PORT: configured ? String(smtp.port) : "",
        SMTP_USER: configured ? SMTP_FIXTURE_USER : "",
        SMTP_PASS: configured ? SMTP_FIXTURE_PASS : "",
        SMTP_SECURE: configured ? "false" : "",
        RESEND_API_KEY: "",
        EMAIL_FROM: configured ? "OpenWork <noreply@example.test>" : "",
      },
    });
    const viewport = { width: 1280, height: 800, deviceScaleFactor: 1 };
    const admin = await seed.web({ den, signedInAs: den.admin, startPath: "/admin/services", headless: true, viewport });
    const member = await seed.web({ den, signedInAs: den.members.member, startPath: "/admin/services", headless: true, viewport });
    const anonymous = await seed.web({ den, startPath: "/admin/services", headless: true, viewport });
    return {
      den, admin, member, anonymous,
      fixtureCalls: fixture.calls, unauthorizedFixtureCalls: fixture.unauthorized, unexpectedFixtureCalls: fixture.unexpected,
      smtpSessions: smtp.sessions, smtpSignIns: smtp.signedIn,
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
