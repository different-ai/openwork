import assert from "node:assert/strict";
import { mkdtemp, chmod, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createUiControlServer } from "../electron/ui-control-server.mjs";

for (const existing of [false, true]) {
  test(`POSIX discovery is owner-only ${existing ? "when replacing a permissive file" : "on first launch"}`, { skip: process.platform === "win32" }, async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "openwork-control-custody-")));
    // The immediate parent deliberately supplies no owner-only privacy.
    await chmod(directory, 0o755);
    const discovery = path.join(directory, "openwork-ui-control.json");
    if (existing) {
      await writeFile(discovery, "old discovery", { mode: 0o644 });
      await chmod(discovery, 0o644);
    }
    const previous = process.env.OPENWORK_UI_CONTROL_DISCOVERY;
    const bridge = createUiControlServer({
      app: { getPath: () => directory }, appName: "Custody test", appIdentifier: "test.openwork.custody",
      getWindow: async () => ({ webContents: { executeJavaScript: async () => ({ ok: true }) } }),
    });
    try {
      await bridge.start();
      assert.equal((await stat(directory)).mode & 0o777, 0o755);
      assert.equal((await stat(discovery)).mode & 0o777, 0o600);
      const connection = JSON.parse(await readFile(discovery, "utf8"));
      assert.equal(new URL(connection.baseUrl).hostname, "127.0.0.1");
      const denied = await fetch(`${connection.baseUrl}/context`);
      assert.equal(denied.status, 401);
      const allowed = await fetch(`${connection.baseUrl}/context`, { headers: { authorization: `Bearer ${connection.token}` } });
      assert.equal(allowed.status, 200);
      assert.deepEqual(await allowed.json(), { ok: true });
    } finally {
      await bridge.stop();
      await rm(directory, { recursive: true, force: true });
      if (previous === undefined) delete process.env.OPENWORK_UI_CONTROL_DISCOVERY;
      else process.env.OPENWORK_UI_CONTROL_DISCOVERY = previous;
    }
  });
}
