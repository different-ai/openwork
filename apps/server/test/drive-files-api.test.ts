import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeConnectCloudMcp } from "../src/connect-state.js";
import { startServer } from "../src/server.js";
import type { ServerConfig } from "../src/types.js";

// Real host HTTP boundary and filesystem; only the connected Cloud service is synthetic.
test("Drive HTTP pulls need no native dialog, preserve workspace boundaries and still gate overwrites/read-only hosts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drive-api-"));
  const root = join(directory, "workspace");
  const alias = join(directory, "workspace-alias");
  await mkdir(root);
  await symlink(root, alias, "dir");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "drive-api-client", hostToken: "drive-api-host", approval: { mode: "auto", timeoutMs: 30_000 }, corsOrigins: [], workspaces: [],
    authorizedRoots: [alias], readOnly: false, startedAt: 0, tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
    configPath: join(directory, "state", "openwork.json"), engineAutoUpgrade: false,
  };
  let downloads = 0;
  const cloud = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer cloud-fixture");
    if (request.url?.includes("/content")) {
      downloads += 1;
      response.end("docx export bytes");
    } else {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        file: { id: "doc-1", name: "Notes", mimeType: "application/vnd.google-apps.document", native: true, revision: "rev-1" },
        download: { format: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: ".docx", exported: true },
      }));
    }
  });
  await new Promise<void>(resolve => cloud.listen(0, "127.0.0.1", resolve));
  const address = cloud.address();
  assert.ok(address && typeof address !== "string");
  let host: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await writeConnectCloudMcp(config, { type: "remote", url: `http://127.0.0.1:${address.port}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: "Bearer cloud-fixture" } });
    host = await startServer(config);
    const call = async (args: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${host!.port}/experimental/drive-files/call`, {
        method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "drive_pull_file", args: { fileId: "doc-1", ...args }, context: { directory: await realpath(root) } }),
      });
      return { status: response.status, body: await response.json() };
    };
    const path = join(await realpath(root), "reports", "notes.docx");
    const pulled = await call({ path });
    assert.equal(pulled.status, 200, JSON.stringify(pulled.body));
    assert.equal(pulled.body.path, "reports/notes.docx");
    assert.equal(await readFile(path, "utf8"), "docx export bytes");
    assert.equal(downloads, 1);

    const escaped = await call({ path: join(directory, "outside.docx") });
    assert.equal(escaped.status, 403);
    assert.equal(escaped.body.code, "path_outside_workspace");
    assert.match(escaped.body.message, /reports\/.*omit path/);

    await writeFile(path, "local edits");
    const overwrite = await call({ path, overwrite: true, approved: true });
    assert.equal(overwrite.status, 403);
    assert.equal(overwrite.body.code, "drive_approval_unavailable");
    assert.equal(await readFile(path, "utf8"), "local edits");

    config.readOnly = true;
    const readonly = await call({ path: "reports/blocked.docx" });
    assert.equal(readonly.status, 403);
    assert.equal(readonly.body.code, "read_only");
    assert.equal(downloads, 1);
  } finally {
    await host?.stop();
    if (cloud.listening) {
      await new Promise<void>(resolve => { cloud.close(() => resolve()); cloud.closeAllConnections(); });
    }
    await rm(directory, { recursive: true, force: true });
  }
});
