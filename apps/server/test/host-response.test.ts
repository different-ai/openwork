import assert from "node:assert/strict";
import { test } from "node:test";
import { readHostResponse } from "../src/host-response.js";
import { createV2ContextBridge, postV2SessionWrite } from "../src/opencode-v2-context-bridge.js";

for (const status of [200, 202, 204, 205]) {
  test(`an empty successful host response (${status}) has no payload`, async () => {
    assert.equal(await readHostResponse(new Response(null, { status })), null);
  });
}

test("nonempty host JSON retains its value", async () => {
  for (const payload of [{ data: { id: "ses_test" } }, [], null, false, 0, "ok"]) {
    assert.deepEqual(await readHostResponse(Response.json(payload)), payload);
  }
});

test("failed host requests retain their HTTP status and JSON message", async () => {
  await assert.rejects(readHostResponse(Response.json({ message: "Model unavailable" }, { status: 409 })),
    { message: "OpenWork request failed (409): Model unavailable" });
  await assert.rejects(readHostResponse(Response.json({ message: 123 }, { status: 403 })),
    { message: "OpenWork request failed (403)" });
  await assert.rejects(readHostResponse(new Response(null, { status: 503 })),
    { message: "OpenWork request failed (503)" });
});

test("malformed nonempty host responses are not treated as empty success", async () => {
  for (const status of [200, 500]) {
    for (const body of ["not json", "{", " "]) {
      await assert.rejects(readHostResponse(new Response(body, { status })), SyntaxError);
    }
  }
});

for (const failure of ["http", "json"]) {
  test(`a failed model response (${failure}) must not dispatch a prompt`, async () => {
    const paths: string[] = [];
    await assert.rejects(postV2SessionWrite("/workspace/ws1/opencode/session/created/prompt_async", {
      model: { providerID: "test-provider", modelID: "test-model" },
      parts: [{ type: "text", text: "Do not start" }],
    }, async (path) => {
      paths.push(path);
      const response = failure === "http"
        ? new Response(null, { status: 409 })
        : new Response("malformed JSON");
      return readHostResponse(response);
    }), failure === "http" ? /OpenWork request failed \(409\)/ : SyntaxError);
    assert.deepEqual(paths, ["/workspace/ws1/opencode2/api/session/created/model"]);
  });
}

for (const selector of ["displayName", "ids", "batch", "default", "linked"]) {
  test(`session.create dispatches its first prompt through the host transport (${selector})`, async () => {
    // The app answers `session.tree` only while it lists started sessions under their parent.
    const linked = selector === "linked";
    const link = { openworkSessionLink: { kind: "sub", parentID: "caller" } };
    const model = { providerID: "test-provider", id: "test-model", variant: "high" };
    const writes: Array<{ path: string; body: unknown }> = [];
    const windowCommands: string[] = [];
    const bridge = await createV2ContextBridge(async (path, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      let response: Response;
      if (path === "/workspaces") {
        response = Response.json({ items: [{ id: "ws1", name: "Test", path: "/work" }] });
      } else if (path === "/workspace/ws1/opencode2/api/session/caller") {
        response = Response.json({ data: { id: "caller", title: "Caller" } });
      } else if (path === "/experimental/ui-control/request") {
        if (body.kind === "query" && body.input.id === "session.tree") {
          assert.deepEqual(body.input.args, { workspaceId: "ws1", sessionId: "caller" });
          response = Response.json(linked
            ? { ok: true, id: "session.tree", effects: { data: "read", ui: "none", external: false }, result: {
              ok: true, workspaceId: "ws1", sessionId: "caller", parent: null, sessions: [], canStartLinked: true,
            } }
            : { ok: false, id: "session.tree", error: "Unknown query: session.tree", code: "unavailable" });
        } else if (body.kind === "query") {
          assert.equal(body.input.id, "models.list");
          response = Response.json({ ok: true, id: "models.list", effects: { data: "read", ui: "none", external: false }, result: {
            ok: true, workspaceId: "ws1", models: [{
              providerId: model.providerID, modelId: model.id,
              displayName: "Test Model", providerName: "Test Provider", available: true,
            }],
          } });
        } else {
          windowCommands.push(body.input.id);
          response = Response.json({ ok: true });
        }
      } else if (init?.method === "POST") {
        writes.push({ path, body });
        if (path === "/workspace/ws1/opencode2/api/session") {
          response = Response.json({ data: { id: "created", title: body.title, model: body.model } });
        } else if (path === "/workspace/ws1/opencode2/api/session/created/model") {
          assert.deepEqual(body, { model });
          // Native V2 returns no JSON after successfully binding the model.
          response = new Response(null, { status: 204 });
        } else {
          assert.equal(path, "/workspace/ws1/opencode2/api/session/created/prompt");
          response = Response.json({ ok: true });
        }
      } else {
        throw new Error(`Unexpected host request ${init?.method ?? "GET"} ${path}`);
      }
      // Use the production decoder, not a mock returning {} for a native 204.
      return readHostResponse(response);
    });
    try {
      const byName = { displayName: "Test Model", variant: "high" };
      const byId = { providerId: model.providerID, modelId: model.id, variant: "high" };
      const response = await fetch(bridge.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "openwork_execute", sessionId: "caller", input: {
          id: "session.create", args: {
            workspaceId: "ws1",
            ...(selector === "batch" ? { model: byName } : {}),
            sessions: [{ title: "Investigate the issue", prompt: "Start the investigation",
              ...(selector === "displayName" ? { model: byName } : selector === "ids" ? { model: byId } : {}),
            }],
          },
        } }),
      });
      const receipt = await response.json();
      assert.equal(response.status, 200, JSON.stringify(receipt));
      assert.equal(receipt.ok, true, JSON.stringify(receipt));
      assert.equal(receipt.result.created.length, 1);
      assert.deepEqual(receipt.result.failures, []);
      assert.equal(receipt.result.created[0].sessionId, "created");
      assert.equal(receipt.result.created[0].started, true);
      // Linked sessions say so, and the result says once that they report back.
      assert.equal(receipt.result.created[0].linked, linked ? true : undefined);
      assert.equal(typeof receipt.result.reports, linked ? "string" : "undefined");
      assert.deepEqual(receipt.result.created[0].model, selector === "default" || linked ? null : {
        providerId: model.providerID, modelId: model.id, variant: "high",
        displayName: "Test Model", providerName: "Test Provider",
      });
      assert.deepEqual(writes, [
        { path: "/workspace/ws1/opencode2/api/session", body: {
          title: "Investigate the issue", ...(selector === "default" || linked ? {} : { model }), ...(linked ? { metadata: link } : {}),
        } },
        ...(selector === "default" || linked ? [] : [{ path: "/workspace/ws1/opencode2/api/session/created/model", body: { model } }]),
        // The first prompt names the session whose agent sent it.
        { path: "/workspace/ws1/opencode2/api/session/created/prompt", body: { text: "Start the investigation", delivery: "steer", metadata: { openworkSentBy: "caller" } } },
      ]);
      assert.deepEqual(windowCommands, ["workspace.reload_sessions"], "no navigation or caller-session writes");
    } finally {
      await bridge.close();
    }
  });
}

test("a created session carries no metadata other than a well-formed link to its parent", async () => {
  const bodies: unknown[] = [];
  const post = async (_path: string, body: Record<string, unknown>) => {
    bodies.push(body);
    return { data: { id: "created", title: "T" } };
  };
  await postV2SessionWrite("/workspace/ws1/opencode/session", {
    title: "T", metadata: { openworkSessionLink: { kind: "sub", parentID: "caller", extra: "dropped" }, other: "dropped" },
  }, post);
  await postV2SessionWrite("/workspace/ws1/opencode/session", {
    title: "T", metadata: { openworkSessionLink: { kind: "owner", parentID: "caller" } },
  }, post);
  await postV2SessionWrite("/workspace/ws1/opencode/session", { title: "T", metadata: "not an object" }, post);
  assert.deepEqual(bodies, [
    { title: "T", metadata: { openworkSessionLink: { kind: "sub", parentID: "caller" } } },
    { title: "T" },
    { title: "T" },
  ]);
});
