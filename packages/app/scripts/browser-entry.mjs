import assert from "node:assert";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { findFreePort, makeClient, parseArgs, spawnOpencodeServe, waitForHealthy } from "./_util.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeSse(res, chunks) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function createTextStream(text) {
  return [
    {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
    {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    },
    {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
}

function createInvalidToolStream() {
  return [
    {
      id: "chatcmpl-2",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
    {
      id: "chatcmpl-2",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "nonexistent_tool", arguments: "{}" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-2",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ];
}

const args = parseArgs(process.argv.slice(2));
const keepTmp = args.get("keep-tmp") === "true";

const results = {
  ok: true,
  steps: [],
};

function step(name, fn) {
  results.steps.push({ name, status: "running" });
  const idx = results.steps.length - 1;
  return Promise.resolve()
    .then(fn)
    .then((data) => {
      results.steps[idx] = { name, status: "ok", data };
    })
    .catch((e) => {
      results.ok = false;
      results.steps[idx] = {
        name,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      };
      throw e;
    });
}

let tmpdir;
let mock;
let opencode;

try {
  tmpdir = await mkdtemp(path.join(os.tmpdir(), "openwork-browser-entry-"));

  const templateUrl = new URL("../src/app/data/commands/browser-setup.md", import.meta.url);
  const template = await readFile(templateUrl, "utf8");

  await step("workspace.setup", async () => {
    await mkdir(path.join(tmpdir, ".opencode", "commands"), { recursive: true });
    await writeFile(path.join(tmpdir, ".opencode", "commands", "browser-setup.md"), template, "utf8");
    return { tmpdir };
  });

  const mockPort = await findFreePort();
  const baseURL = `http://127.0.0.1:${mockPort}/v1`;

  await step("provider.mock.start", async () => {
    mock = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "qwen-plus", object: "model" }],
          }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const raw = await new Promise((resolve) => {
          let data = "";
          req.setEncoding("utf8");
          req.on("data", (chunk) => (data += chunk));
          req.on("end", () => resolve(data));
        });

        let body;
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          body = {};
        }

        const haystack = JSON.stringify(body).toLowerCase();
        const safe = haystack.includes("do not call any tools");

        if (safe) {
          writeSse(res, createTextStream("Browser automation setup: tell me if you're on desktop or web, then we'll enable the browser plugin/extension."));
        } else {
          writeSse(res, createInvalidToolStream());
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });

    await new Promise((resolve) => mock.listen(mockPort, "127.0.0.1", resolve));
    return { baseURL };
  });

  await step("workspace.config", async () => {
    await writeFile(
      path.join(tmpdir, "opencode.json"),
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["alibaba"],
          provider: {
            alibaba: {
              options: {
                apiKey: "test-key",
                baseURL,
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    return {};
  });

  const port = await findFreePort();
  opencode = await spawnOpencodeServe({ directory: tmpdir, port });
  const client = makeClient({ baseUrl: opencode.baseUrl, directory: opencode.cwd });

  await step("health", async () => {
    const health = await waitForHealthy(client);
    return health;
  });

  let sessionId;

  await step("session.create", async () => {
    const session = await client.session.create({ title: "OpenWork browser-entry test" });
    sessionId = session.id;
    assert.ok(sessionId);
    return { id: session.id };
  });

  await step("session.command (browser-setup)", async () => {
    await client.session.command({
      sessionID: sessionId,
      command: "browser-setup",
      arguments: "",
      model: "alibaba/qwen-plus",
    });
    return {};
  });

  await step("assert.no-tool-errors", async () => {
    const start = Date.now();
    while (Date.now() - start < 12_000) {
      const msgs = await client.session.messages({ sessionID: sessionId, limit: 50 });
      const parts = msgs.flatMap((m) => m.parts ?? []);
      const toolErrors = parts.filter((p) => p?.type === "tool" && String(p?.state?.status ?? "").toLowerCase() === "error");
      if (toolErrors.length > 0) {
        const first = toolErrors[0];
        const tool = typeof first.tool === "string" ? first.tool : "tool";
        const title = typeof first.state?.title === "string" ? first.state.title : "";
        const err = typeof first.state?.error === "string" ? first.state.error : "";
        throw new Error(`Unexpected tool error (${tool}): ${title} ${err}`.trim());
      }

      const hasAssistantText = msgs.some(
        (m) => m.info?.role === "assistant" && (m.parts ?? []).some((p) => p.type === "text" && String(p.text ?? "").trim()),
      );
      if (hasAssistantText) {
        return { messages: msgs.length };
      }

      await sleep(250);
    }
    throw new Error("Timed out waiting for assistant response");
  });

  console.log(JSON.stringify(results, null, 2));
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  results.ok = false;
  results.error = message;
  results.stderr = opencode?.getStderr?.() ?? "";
  console.error(JSON.stringify(results, null, 2));
  process.exitCode = 1;
} finally {
  try {
    if (opencode) await opencode.close();
  } catch {
    // ignore
  }
  try {
    if (mock) await new Promise((resolve) => mock.close(() => resolve()));
  } catch {
    // ignore
  }
  try {
    if (tmpdir && !keepTmp) await rm(tmpdir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
