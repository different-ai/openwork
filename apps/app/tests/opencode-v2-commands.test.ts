import { afterEach, describe, expect, test } from "bun:test";
import { createClientV2, mergeV2CommandCatalog } from "../src/app/lib/opencode-v2-adapter";
import { listCommands } from "../src/app/lib/opencode-session";

const base = "http://127.0.0.1:9/workspace/ws_1/opencode2";
const originalFetch = globalThis.fetch;

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return handler(request);
    },
  });
  return requests;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenCode v2 slash commands", () => {
  test("merges native commands with workspace skills, commands first, Cloud skills left to Connect", () => {
    expect(mergeV2CommandCatalog(
      [{ name: "review", description: "review changes" }, { name: "wrapup" }, { description: "no name" }],
      [
        { id: "wrapup", name: "Wrap up", description: "skill clash" },
        { id: "demo-skill", name: "Demo", description: "A demo skill" },
        { id: "openwork-cloud-shared", name: "Shared" },
      ],
    )).toEqual([
      { name: "review", description: "review changes", source: "command" },
      { name: "wrapup", source: "command" },
      { name: "demo-skill", description: "A demo skill", source: "skill" },
    ]);
  });

  test("the composer list reads the engine's commands instead of an empty stub", async () => {
    const requests = serve((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/api/command")) return Response.json({ location: {}, data: [{ name: "wrapup", description: "Wrap up the session" }] });
      if (path.endsWith("/api/skill")) return Response.json({ location: {}, data: [{ id: "demo-skill", name: "Demo", path: "/x", content: "" }] });
      return new Response(null, { status: 404 });
    });
    const client = createClientV2(base, "/tmp/ws", { token: "t" });
    expect(await listCommands(client, "/tmp/ws")).toEqual([
      { id: "cmd:wrapup", name: "wrapup", description: "Wrap up the session", source: "command", template: undefined, hints: undefined, agent: undefined, model: undefined, subtask: false },
      { id: "cmd:demo-skill", name: "demo-skill", description: undefined, source: "skill", template: undefined, hints: undefined, agent: undefined, model: undefined, subtask: false },
    ]);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/workspace/ws_1/opencode2/api/command",
      "/workspace/ws_1/opencode2/api/skill",
    ]);
  });

  test("a cold location's first empty answer is read again", async () => {
    let reads = 0;
    serve((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/api/command")) {
        reads += 1;
        return Response.json({ location: {}, data: reads === 1 ? [] : [{ name: "init" }] });
      }
      return Response.json({ location: {}, data: [] });
    });
    const client = createClientV2(base, "/tmp/ws", { token: "t" });
    const result = await client.command.list({ directory: "/tmp/ws" });
    expect(result.data).toEqual([{ name: "init", source: "command" }]);
    expect(reads).toBe(2);
  });

  test("running a command posts its name and arguments, setting the model first when given", async () => {
    const requests = serve((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/command")) return new Response(null, { status: 204 });
      if (path.endsWith("/model")) return Response.json({ data: {} });
      return new Response(null, { status: 404 });
    });
    const client = createClientV2(base, "/tmp/ws", { token: "t" });
    const result = await client.session.command({
      sessionID: "ses_1",
      command: "wrapup",
      arguments: "the release",
      model: "openwork/auto/v1",
    });
    expect(result.error).toBeUndefined();
    const sent = await Promise.all(requests.map(async (request) => ({
      method: request.method,
      path: new URL(request.url).pathname.replace("/workspace/ws_1/opencode2", ""),
      body: await request.json(),
    })));
    expect(sent).toEqual([
      { method: "POST", path: "/api/session/ses_1/model", body: { model: { providerID: "openwork", id: "auto/v1" } } },
      { method: "POST", path: "/api/session/ses_1/command", body: { name: "wrapup", text: "the release" } },
    ]);
  });

  test("an unknown command surfaces the engine's not-found error", async () => {
    const notFound = { _tag: "CommandNotFoundError", command: "nope", message: "Command not found: nope" };
    serve(() => Response.json(notFound, { status: 404 }));
    const client = createClientV2(base, "/tmp/ws", { token: "t" });
    const result = await client.session.command({ sessionID: "ses_1", command: "nope", arguments: "" });
    expect(result.error).toEqual(notFound);
    expect(result.response.status).toBe(404);
  });
});
