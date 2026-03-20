import assert from "node:assert/strict";

import { findFreePort, makeClient, parseArgs, spawnOpencodeServe, waitForHealthy } from "./_util.mjs";

const args = parseArgs(process.argv.slice(2));
const directory = args.get("dir") ?? process.cwd();

const port = await findFreePort();
const server = await spawnOpencodeServe({ directory, port });

const results = {
  ok: true,
  baseUrl: server.baseUrl,
  directory: server.cwd,
  steps: [],
};

function formatError(e) {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

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
      results.steps[idx] = { name, status: "error", error: formatError(e) };
      throw e;
    });
}

const targetPath = args.get("path") ?? "src/app/pages/session.tsx";
const absolutePath = (() => {
  const trimmed = String(targetPath || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("/")) return trimmed;
  if (/^[a-zA-Z]:\\/.test(trimmed)) return trimmed;
  return (server.cwd + "/" + trimmed).replace("//", "/");
})();
const fileUrl = absolutePath ? `file://${absolutePath}` : "";

try {
  const client = makeClient({ baseUrl: server.baseUrl, directory: server.cwd });
  await step("health", async () => waitForHealthy(client));

  let sessionId = "";
  await step("session.create", async () => {
    const session = await client.session.create({ title: "OpenWork mention-send" });
    sessionId = session.id;
    assert.ok(sessionId);
    return { id: session.id };
  });

  async function messagesSummary(label) {
    const msgs = await client.session.messages({ sessionID: sessionId, limit: 50 });
    const roles = msgs.map((m) => m?.role ?? m?.info?.role ?? null);
    const user = msgs.filter((m) => (m?.role ?? m?.info?.role ?? null) === "user");
    const last = user[user.length - 1];
    const lastParts = Array.isArray(last?.parts) ? last.parts : [];
    return {
      label,
      total: msgs.length,
      userCount: user.length,
      roles: Array.from(new Set(roles)),
      lastMessageRole: msgs.length ? (msgs[msgs.length - 1]?.role ?? msgs[msgs.length - 1]?.info?.role ?? null) : null,
      sampleKeys: msgs.length ? Object.keys(msgs[0] ?? {}) : [],
      sample: msgs.length
        ? {
            role: msgs[0]?.role ?? msgs[0]?.info?.role ?? null,
            parts: Array.isArray(msgs[0]?.parts) ? msgs[0].parts.map((p) => p.type) : [],
          }
        : null,
      lastUserParts: lastParts.map((p) => p.type),
      lastUserText: (lastParts.find((p) => p.type === "text")?.text ?? ""),
    };
  }

  await step("messages.initial", async () => messagesSummary("initial"));

  await step("prompt.invalidFilePart", async () => {
    // Mirrors the bug in OpenWork: sending a file mention with only {path}.
    try {
      await client.session.prompt({
        sessionID: sessionId,
        noReply: true,
        parts: [
          { type: "text", text: " " },
          { type: "file", path: targetPath },
        ],
      });
      throw new Error("expected prompt to fail validation, but it succeeded");
    } catch (e) {
      return { expectedFailure: true, error: formatError(e) };
    }
  });

  await step("prompt.spaceTextWithValidFile", async () => {
    assert.ok(fileUrl, "missing file url");
    await client.session.prompt({
      sessionID: sessionId,
      noReply: true,
      parts: [
        { type: "text", text: " " },
        { type: "file", mime: "text/plain", url: fileUrl, filename: "session.tsx" },
      ],
    });
    return messagesSummary("after-space-text");
  });

  await step("prompt.fixedPayload", async () => {
    assert.ok(fileUrl, "missing file url");
    await client.session.prompt({
      sessionID: sessionId,
      noReply: true,
      parts: [
        { type: "text", text: `@${targetPath}` },
        { type: "file", mime: "text/plain", url: fileUrl, filename: "session.tsx" },
      ],
    });
    const summary = await messagesSummary("after-fixed");
    assert.ok(summary.lastUserText.includes(targetPath), "expected last user text to include the mentioned path");
    return summary;
  });

  console.log(JSON.stringify(results, null, 2));
} catch (e) {
  results.ok = false;
  results.error = formatError(e);
  results.stderr = server.getStderr();
  console.error(JSON.stringify(results, null, 2));
  process.exitCode = 1;
} finally {
  await server.close();
}
