import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { z } from "zod";
import { createManagedOpencodeV2Server } from "../src/managed-opencode-v2.js";
import { createV2ContextBridge } from "../src/opencode-v2-context-bridge.js";
import { groupHost } from "./fixtures/native-codemode-groups.js";

const binary = process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode2";
const modelInput = z.object({
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() })),
});
const catalogSchema = z.object({ items: z.array(z.object({ path: z.string() })) });
function unwrap(value: unknown): unknown {
  if (typeof value === "string") {
    try { return unwrap(JSON.parse(value)); } catch { return value; }
  }
  if (value && typeof value === "object" && "value" in value) return unwrap(value.value);
  return value;
}

test("the pinned native engine discovers and runs OpenWork group queries and commands inside one Code Mode loop", { timeout: 90_000 }, async t => {
  try { await access(binary); } catch { t.skip("needs: OpenCode V2 binary; set OPENWORK_TEST_OPENCODE2"); return; }
  const root = await mkdtemp(join(tmpdir(), "openwork-native-codemode-"));
  const home = join(root, "home");
  const directory = join(root, "project");
  await mkdir(home); await mkdir(directory);
  const { assignments, writes, request } = groupHost();
  const bridge = await createV2ContextBridge(request);
  let observed: unknown;
  let failure: unknown;
  const model = createServer(async (req, res) => {
    const frame = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "native-codemode", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    try {
      let text = "";
      for await (const chunk of req) text += String(chunk);
      const body = modelInput.parse(JSON.parse(text));
      const results = body.messages.filter(message => message.role === "tool");
      const execute = body.tools?.find(tool => tool.function.name === "execute");
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (!execute) { res.end(frame({ role: "assistant", content: "Native Code Mode proof" }) + frame({}, "stop") + "data: [DONE]\n\n"); return; }
      let code: string;
      if (!results.length) code = 'return search({query:"OpenWork sidebar groups",limit:20});';
      else if (results.length === 1) {
        const catalog = catalogSchema.parse(unwrap(results[0]?.content));
        const query = catalog.items.find(item => item.path.endsWith(".openwork_query"));
        const command = catalog.items.find(item => item.path.endsWith(".openwork_execute"));
        assert.ok(query, JSON.stringify(catalog)); assert.ok(command, JSON.stringify(catalog));
        code = `const decode = value => typeof value === "string" ? JSON.parse(value) : value;
          const before = decode(await ${query.path}({id:"session.group.list",args:{workspaceId:"ws1"}}));
          let moved = 0;
          for (const group of before.result.groups) {
            if (group.id !== "working") continue;
            for (const session of group.sessions) {
              const sessionId = session.sessionId;
              if (sessionId === "keep") continue;
              const receipt = decode(await ${command.path}({id:"session.group.move",args:{workspaceId:"ws1",sessionId,groupId:"done"}}));
              if (!receipt.ok) throw new Error("Move failed");
              moved++;
            }
          }
          const after = decode(await ${query.path}({id:"session.group.list",args:{workspaceId:"ws1"}}));
          const assignments = {};
          for (const group of after.result.groups) for (const session of group.sessions) assignments[session.sessionId] = group.id;
          return {moved,assignments};`;
      } else {
        observed = unwrap(results.at(-1)?.content);
        res.end(frame({ role: "assistant", content: "Native group loop verified" }) + frame({}, "stop") + "data: [DONE]\n\n"); return;
      }
      res.end(frame({ role: "assistant", tool_calls: [{ index: 0, id: `call_${results.length}`, type: "function", function: { name: execute.function.name, arguments: JSON.stringify({ code }) } }] }) + frame({}, "tool_calls") + "data: [DONE]\n\n");
    } catch (error) { failure = error; res.end(frame({ role: "assistant", content: "Native witness failed" }) + frame({}, "stop") + "data: [DONE]\n\n"); }
  });
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  const address = model.address(); assert.ok(address && typeof address !== "string");
  let engine: Awaited<ReturnType<typeof createManagedOpencodeV2Server>> | undefined;
  try {
    engine = await createManagedOpencodeV2Server({ bin: binary, rootDir: join(root, "engine"), contextTools: bridge,
      env: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), OPENCODE_DISABLE_MODELS_FETCH: "true" } });
    await engine.injectProvider({ id: "native_fixture", name: "Native fixture", apiKey: "fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: "fixture", name: "Fixture", config: { limit: { context: 128000, output: 4096 }, tool_call: true } }] });
    const created = await engine.fetchJson("/api/session", { method: "POST", body: { title: "Native Code Mode witness", location: { directory }, model: { providerID: "native_fixture", id: "fixture" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] } });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const session = z.object({ data: z.object({ id: z.string() }) }).parse(created.json);
    const prompt = await engine.fetchJson(`/api/session/${session.data.id}/prompt`, { method: "POST", body: { text: "Discover the OpenWork tools, move the other working sessions to done, keep the exception, and verify." } });
    assert.equal(prompt.status, 200, JSON.stringify(prompt.json));
    for (let attempt = 0; attempt < 600 && observed === undefined && failure === undefined; attempt++) await delay(50);
    if (failure) throw failure;
    assert.deepEqual(observed, { moved: 2, assignments: { keep: "working", "move-a": "done", "move-b": "done" } });
    assert.equal(writes.length, 2);
    assert.equal(assignments.keep, "working");
  } finally { await engine?.close(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); await bridge.close(); await rm(root, { recursive: true, force: true }); }
});
