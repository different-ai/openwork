import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

import {
  findFreePort,
  makeClient,
  normalizeEvent,
  parseArgs,
  spawnOpencodeServe,
  waitForHealthy,
} from "./_util.mjs";

const args = parseArgs(process.argv.slice(2));
const directory = args.get("dir") ?? process.cwd();

const port = await findFreePort();
const server = await spawnOpencodeServe({ directory, port });

try {
  const client = makeClient({ baseUrl: server.baseUrl, directory: server.cwd });
  await waitForHealthy(client);

  const requirePermission = args.get("require") === "true";

  // Pick an agent name (session.shell requires it).
  const agents = await client.app.agents();
  const agentName = agents?.[0]?.name ?? "default";

  // Create a session that asks for tool permission.
  const session = await client.session.create({
    title: "OpenWork permission test",
    permission: [
      {
        permission: "bash",
        pattern: "*",
        action: "ask",
      },
    ],
  });

  const events = [];
  const controller = new AbortController();
  const sub = await client.event.subscribe(undefined, { signal: controller.signal });

  let asked = null;
  let shellError = null;
  let externalRead = null;

  const reader = (async () => {
    try {
      for await (const raw of sub.stream) {
        const evt = normalizeEvent(raw);
        if (!evt) continue;
        events.push(evt);
        if (evt.type === "permission.asked") {
          asked = evt;
          break;
        }
      }
    } catch {
      // Ignore abort errors.
    }
  })();

  // Try to trigger a bash tool call without needing UI.
  // This endpoint requires an agent name, and may still fail if no provider/model is configured.
  try {
    await client.session.shell({
      sessionID: session.id,
      agent: agentName,
      command: "pwd",
    });
  } catch (e) {
    shellError = e instanceof Error ? e.message : String(e);
  }

  // Try to trigger an external-directory permission request deterministically.
  const externalPath = "/tmp/openwork-permission-test.txt";
  await writeFile(externalPath, "openwork permission test\n", "utf8");

  try {
    await client.file.read({ path: externalPath });
    externalRead = { path: externalPath, firstAttempt: "ok" };
  } catch (e) {
    externalRead = {
      path: externalPath,
      firstAttempt: "error",
      firstError: e instanceof Error ? e.message : String(e),
    };
  }

  await new Promise((r) => setTimeout(r, 2200));

  controller.abort();
  await Promise.race([reader, new Promise((r) => setTimeout(r, 500))]);

  const pending = await client.permission.list();
  assert.ok(Array.isArray(pending));

  const reqFromEvent =
    asked && asked.properties && typeof asked.properties === "object" ? asked.properties : null;
  const reqFromList = pending.find((p) => p && p.sessionID === session.id) ?? pending[0] ?? null;
  const req = reqFromEvent ?? reqFromList;

  if (req) {
    assert.ok(typeof req.id === "string");

    await client.permission.reply({ requestID: req.id, reply: "once" });

    if (externalRead && externalRead.firstAttempt === "error") {
      try {
        await client.file.read({ path: externalRead.path });
        externalRead.afterReply = "ok";
      } catch (e) {
        externalRead.afterReply = "error";
        externalRead.afterReplyError = e instanceof Error ? e.message : String(e);
      }
    }

    console.log(
      JSON.stringify({
        ok: true,
        baseUrl: server.baseUrl,
        sessionId: session.id,
        agentName,
        shellError,
        externalRead,
        permissionAsked: true,
        requestId: req.id,
        requestedPermission: req.permission,
        pendingCountBeforeReply: pending.length,
        observedEventTypes: Array.from(new Set(events.map((e) => e.type))).slice(0, 25),
      }),
    );
  } else {
    if (requirePermission) {
      assert.fail(
        `No permission request observed (agent=${agentName}). shellError=${shellError ?? "<none>"}`,
      );
    }

    console.log(
      JSON.stringify({
        ok: true,
        baseUrl: server.baseUrl,
        sessionId: session.id,
        agentName,
        shellError,
        externalRead,
        permissionAsked: false,
        note:
          "No permission request observed. This usually means the server never attempted a tool call (often due to missing agent/model/provider configuration).",
        pendingCount: pending.length,
        observedEventTypes: Array.from(new Set(events.map((e) => e.type))).slice(0, 25),
      }),
    );
  }
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(JSON.stringify({ ok: false, error: message, stderr: server.getStderr() }));
  process.exitCode = 1;
} finally {
  await server.close();
}
