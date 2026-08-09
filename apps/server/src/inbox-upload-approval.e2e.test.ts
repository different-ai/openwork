import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

const APPROVAL_TIMEOUT_MS = 1_500;

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function startManualApprovalServer() {
  const root = await mkdtemp(join(tmpdir(), "openwork-inbox-approval-"));
  roots.push(root);
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    // The web/gateway posture: nobody answers approval prompts, so anything
    // that parks on the approval queue hangs for timeoutMs and then fails.
    approval: { mode: "manual", timeoutMs: APPROVAL_TIMEOUT_MS },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, token: config.token, root };
}

describe("inbox uploads under manual approval mode", () => {
  test("chat-attachment inbox upload succeeds immediately without host approval", async () => {
    const { base, token, root } = await startManualApprovalServer();
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const form = new FormData();
    form.append("file", new File([bytes], "screenshot.png", { type: "image/png" }));
    const inboxPath = "chat-attachments/session-1/att-1-screenshot.png";

    const startedAt = Date.now();
    const response = await fetch(
      `${base}/workspace/ws_1/inbox?path=${encodeURIComponent(inboxPath)}`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form },
    );
    const elapsedMs = Date.now() - startedAt;

    // Positive half: the upload lands and reports the exact byte count.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, path: inboxPath, bytes: bytes.length });

    // Negative half: it must not have parked on the approval queue. Before the
    // fix this request waited the full approval timeout and returned 403
    // write_denied, which is what froze web/gateway attachment sends.
    expect(elapsedMs).toBeLessThan(APPROVAL_TIMEOUT_MS);

    // The bytes are intact and confined to the inbox drop area.
    const dest = join(root, ".opencode", "openwork", "inbox", inboxPath);
    expect(Array.from(new Uint8Array(await readFile(dest)))).toEqual(Array.from(bytes));
  });

  test("other workspace writes remain approval-gated (fix is not a blanket bypass)", async () => {
    const { base, token, root } = await startManualApprovalServer();

    const startedAt = Date.now();
    const response = await fetch(`${base}/workspace/ws_1/files/content`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "notes/unapproved.md", content: "# should not land\n" }),
    });
    const elapsedMs = Date.now() - startedAt;

    // A regular file write still parks on the approval queue and is denied
    // after the timeout because nobody approves it.
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "write_denied", details: { reason: "timeout" } });
    expect(elapsedMs).toBeGreaterThanOrEqual(APPROVAL_TIMEOUT_MS - 100);

    // And the file must not exist on disk.
    await expect(stat(join(root, "notes", "unapproved.md"))).rejects.toThrow();
  });
});
