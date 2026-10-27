import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { browserScript } from "@openwork/cdp";
import { signIn } from "@openwork/behaviors";
import type { Place, Seed } from "@openwork/env";
import { z } from "zod";
import { denForAppWeb } from "./signed-in-app-web.ts";

const AUTO = { providerID: "openwork-free", modelID: "openai/gpt-6-luna" };

const record = z.record(z.string(), z.unknown());

/**
 * The hosted free-Auto Gateway, stood in for on loopback: a ready allowance
 * for a signed-out desktop, and its model calls answered by the model witness.
 * The app's own local relay (`openwork-free`) is untouched and talks to it as
 * it would talk to the Gateway.
 */
async function freeAutoGateway(witnessUrl: string): Promise<{ origin: string; requests: () => string[]; stop: () => Promise<void> }> {
  const seen: string[] = [];
  const forward: Record<string, string> = {
    "/api/anonymous/v1/chat/completions": "/v1/chat/completions",
    "/api/anonymous/v1/responses": "/v1/responses",
  };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      seen.push(`${request.method ?? "GET"} ${path}`);
      if (request.method === "GET" && path === "/api/anonymous/status") {
        const resetsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ state: "ready", code: null, allowance: { limitUsd: 5, usedUsd: 0, remainingUsd: 5, resetsAt } }));
        return;
      }
      if (request.method === "GET" && path === "/api/anonymous/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: AUTO.modelID, object: "model" }] }));
        return;
      }
      const target = request.method === "POST" ? forward[path] : undefined;
      if (!target) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "not_found" } }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const upstream = await fetch(`${witnessUrl}${target}`, {
        method: "POST", body: Buffer.concat(chunks),
        headers: { "content-type": "application/json", authorization: "Bearer free-auto-fixture" },
      });
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      const reader = upstream.body?.getReader();
      for (let chunk = await reader?.read(); chunk && !chunk.done; chunk = await reader?.read()) response.write(chunk.value);
      response.end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests: () => [...seen],
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * One person on a desktop without a signed-in account: a local workspace whose
 * free Auto runs through the app's real local relay to a loopback Gateway
 * answered by a model witness, one conversation, and a Den with Acme where
 * that person (Riley) and a teammate (Jordan) have accounts. Nothing signs the
 * app in: every sign-in in the spec goes through the app's own paste-code UI
 * with a fresh, single-use handoff grant. Returning to the task is always on.
 */
export async function desktopSignInReturnsToTask(seed: Seed, { place }: { place: Place }) {
  await using setup = new AsyncDisposableStack();
  const prompt = "Summarize the attached contract and list renewal dates.";
  const reply = "The contract runs 12 months from Mar 1 and renews automatically unless either side gives 60 days' notice.";
  const witness = (await seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{ promptMarker: prompt, latestUserTurn: true, finalReply: reply, steps: [] }] }).boot(place)).handle;
  setup.defer(() => witness.stop());
  const gateway = await freeAutoGateway(witness.url);
  setup.defer(() => gateway.stop());

  const { den, webPort } = await denForAppWeb(seed, {
    org: {
      name: "Acme",
      admin: { name: "Acme Owner" },
      members: { riley: { name: "Riley" }, jordan: { name: "Jordan" } },
    },
  });
  const riley = den.members.riley;
  const jordan = den.members.jordan;
  if (!riley || !jordan) throw new Error("Both Acme member accounts must be provisioned.");

  const directory = seed.tmpPath("signin-returns-to-task");
  await mkdir(directory, { recursive: true });
  // Match the engine's canonical directory on hosts where /var is a symlink.
  const workspacePath = await realpath(directory);
  const token = randomUUID();
  const app = await seed.appWeb({
    den: den.ref, webPort, workspacePath, name: "signin-returns-to-task", headless: true, mouse: true,
    // Hosted models are switched off for isolated app instances; this world
    // keeps them on and points free Auto at the loopback Gateway.
    env: { OPENWORK_TOKEN: token, OPENWORK_DEV_MODE: "1", VITE_DISABLE_OPENWORK_MODELS: "0", OPENWORK_FREE_INFERENCE_ORIGIN: gateway.origin },
  });

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const server = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${app.openworkUrl}${path}`, { ...init, headers });
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) as unknown : null };
  };
  const listed = await server("/workspaces");
  const workspaces = z.object({ workspaces: z.array(z.object({ id: z.string(), path: z.string() })) }).parse(listed.body).workspaces;
  const workspace = workspaces.find((candidate) => candidate.path === workspacePath);
  if (!workspace) throw new Error("The desktop's local workspace is not registered.");
  const mount = `/workspace/${encodeURIComponent(workspace.id)}`;
  const created = await server(`${mount}/opencode/session`, { method: "POST", body: JSON.stringify({ title: "Contract summary" }) });
  if (!created.response.ok) throw new Error(`Arranging the conversation failed: ${created.response.status}`);
  const sessionId = z.object({ id: z.string() }).parse(created.body).id;
  const sessionPath = `${mount}/session/${sessionId}`;

  // TODO(primitive): select the starting model. The desktop picks Auto on its
  // own at first launch (an Electron-only effect); the app in a browser does not.
  await seed.evalIn(app, browserScript((model) => {
    const raw = localStorage.getItem("openwork.preferences");
    let preferences: Record<string, unknown> = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({ ...preferences, defaultModel: model, modelVariant: null, providerStepCompleted: true }));
    localStorage.setItem("openwork.defaultModel", `${model.providerID}/${model.modelID}`);
    return true;
  }, [AUTO]));

  const people = { riley, jordan };
  const resources = setup.move();
  return {
    app, den, prompt, reply, sessionId, sessionPath,
    sessionUrl: `${app.webUrl}${sessionPath}`,
    settingsUrl: `${app.webUrl}/settings/cloud-account`,
    /** Model calls that reached the stand-in Gateway through the app's relay. */
    gatewayRequests: () => gateway.requests(),
    /** A fresh single-use desktop handoff grant, minted when the person finishes signing in in the browser (grants live five minutes). */
    async grantFor(person: keyof typeof people) {
      const member = people[person];
      const session = await signIn(den.ref, { email: member.email, password: member.password });
      const issued = await seed.api(session, "/v1/auth/desktop-handoff", { method: "POST", body: JSON.stringify({ desktopScheme: "openwork" }) });
      if (!issued.response.ok) throw new Error(`Issue handoff: HTTP ${issued.response.status}`);
      const grant = record.parse(issued.body).grant;
      if (typeof grant !== "string" || !grant) throw new Error("The handoff response had no grant.");
      return grant;
    },
    /** Conversations and workspaces on this desktop, from its local server. */
    async localCounts() {
      const sessions = await server(`${mount}/opencode/session`);
      const all = await server("/workspaces");
      return {
        sessions: z.array(z.object({ id: z.string() })).parse(sessions.body).length,
        workspaces: z.object({ workspaces: z.array(z.object({ id: z.string() })) }).parse(all.body).workspaces.length,
      };
    },
    [Symbol.asyncDispose]: () => resources[Symbol.asyncDispose](),
  };
}
