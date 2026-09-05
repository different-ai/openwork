import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createUiControlServer } from "./ui-control-server.mjs";

test("UI control commands never activate the desktop window implicitly", async () => {
  const source = await readFile(new URL("./ui-control-server.mjs", import.meta.url), "utf8");

  assert.match(source, /webContents\.executeJavaScript/);
  assert.doesNotMatch(source, /\bwin\.(?:show|restore|focus)\(/);
});

test("UI control failures are logged locally without exposing exception details", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "openwork-ui-control-"));
  const failure = new Error("private renderer failure");
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args);
  const server = createUiControlServer({
    app: { getPath: () => userData },
    appName: "OpenWork",
    appIdentifier: "com.differentai.openwork",
    getWindow: async () => { throw failure; },
  });

  try {
    await server.start();
    const discovery = JSON.parse(await readFile(path.join(userData, "openwork-ui-control.json"), "utf8"));
    const response = await fetch(`${discovery.baseUrl}/snapshot`, {
      headers: { Authorization: `Bearer ${discovery.token}` },
    });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, { ok: false, error: "OpenWork UI control request failed." });
    assert.equal(logged[0]?.[0], "[ui-control] request failed");
    assert.equal(logged[0]?.[1], failure);
    assert.doesNotMatch(JSON.stringify(payload), /private renderer failure/);
  } finally {
    await server.stop();
    console.error = originalConsoleError;
    await rm(userData, { recursive: true, force: true });
  }
});
