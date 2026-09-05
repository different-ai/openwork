import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected a JSON object");
  return value;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) raw += String(chunk);
  return raw ? record(JSON.parse(raw)) : {};
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

/** HTTP witness for Daytona and its native session endpoint; no real cloud resources. */
export async function startCloudRuntimeWitness() {
  const sandboxes: Array<{ id: string; name: string; workerId: string }> = [];
  const sessions: Array<{ id: string; sandboxId: string; title: string; prompts: string[] }> = [];
  const unexpected: string[] = [];
  let healthy = false;
  let url = "";

  function sandboxDto(sandbox: typeof sandboxes[number]) {
    return {
      id: sandbox.id, name: sandbox.name, state: "started", target: "test",
      toolboxProxyUrl: `${url}/toolbox/${sandbox.id}`, labels: {},
    };
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const method = request.method ?? "GET";
    if (method === "GET" && /\/volumes?\//.test(path)) {
      return json(response, 200, { id: "volume_witness", name: "witness", state: "ready" });
    }
    if (method === "POST" && path === "/sandbox") {
      const input = await body(request);
      const env = record(input.env);
      const sandbox = { id: `sandbox_${sandboxes.length + 1}`, name: String(input.name), workerId: String(env.DEN_WORKER_ID) };
      sandboxes.push(sandbox);
      return json(response, 201, sandboxDto(sandbox));
    }
    const preview = path.match(/^\/sandbox\/([^/]+)\/.*preview/);
    if (method === "GET" && preview) return json(response, 200, { url: `${url}/runtime/${preview[1]}` });
    const lookup = path.match(/^\/sandbox\/([^/]+)$/);
    if (method === "GET" && lookup) {
      const sandbox = sandboxes.find((entry) => entry.id === lookup[1] || entry.name === lookup[1]);
      return json(response, sandbox ? 200 : 404, sandbox ? sandboxDto(sandbox) : { message: "Sandbox not found" });
    }
    if (path.includes("/process/session")) {
      if (method === "POST" && path.endsWith("/exec")) return json(response, 200, { cmdId: "boot_witness" });
      return json(response, 200, {});
    }
    const runtime = path.match(/^\/runtime\/([^/]+)(.*)$/);
    if (runtime) {
      const sandboxId = runtime[1];
      const route = runtime[2];
      if (route === "/health") return json(response, healthy ? 200 : 503, { ready: healthy });
      if (route === "/workspaces") return json(response, 200, { activeId: "workspace_witness", items: [] });
      if (method === "POST" && route === "/workspace/workspace_witness/opencode/session") {
        const input = await body(request);
        const session = { id: `ses_witness_${sessions.length + 1}`, sandboxId, title: String(input.title), prompts: [] };
        sessions.push(session);
        return json(response, 200, { id: session.id, title: session.title, directory: "/workspace", time: { created: 1 } });
      }
      const prompt = route?.match(/^\/workspace\/workspace_witness\/opencode\/session\/([^/]+)\/prompt_async$/);
      if (method === "POST" && prompt) {
        const session = sessions.find((entry) => entry.id === prompt[1] && entry.sandboxId === sandboxId);
        if (!session) return json(response, 404, { message: "Session not found" });
        const input = await body(request);
        for (const part of Array.isArray(input.parts) ? input.parts : []) session.prompts.push(String(record(part).text));
        return json(response, 200, {});
      }
      // The isolated organization has no model providers to materialize.
      if (route === "/opencode/config") return json(response, 200, {});
    }
    unexpected.push(`${method} ${path}`);
    json(response, 404, { message: `Unimplemented witness route: ${method} ${path}` });
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      unexpected.push(error instanceof Error ? error.message : String(error));
      json(response, 500, { message: "Cloud witness failed" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cloud witness has no listening address");
  url = `http://127.0.0.1:${address.port}`;
  return {
    url, sandboxes, sessions, unexpected,
    ready() { healthy = true; },
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
