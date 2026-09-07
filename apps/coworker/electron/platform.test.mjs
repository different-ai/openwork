/**
 * Integration proof of Open Coworker's core composition claim: a coworker directory
 * created by the store becomes an ordinary OpenWork workspace on the same
 * embedded server bundle the desktop apps ship.
 *
 * Engine-free (manageOpencode: false) so it stays deterministic and needs no
 * opencode binary or model credentials. Skips itself when the server bundle
 * has not been built (`pnpm --filter openwork-server build`).
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { createCoworker, getCoworker, updateCoworker } from "./coworkers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const embeddedBundle = path.resolve(__dirname, "..", "..", "server", "dist", "embedded.js");

test(
  "coworker directory registers as a native OpenWork workspace on the embedded server",
  { skip: existsSync(embeddedBundle) ? false : "openwork-server dist is not built" },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "coworker-platform-"));
    const coworkersDir = path.join(root, "coworkers");
    const configPath = path.join(root, "config", "coworker-server.json");
    // Isolate every derived config path (registry, runtime DB) inside the
    // temp root before the server module reads the environment.
    process.env.OPENWORK_SERVER_CONFIG = configPath;

    const clientToken = "coworker-test-client-token";
    const hostToken = "coworker-test-host-token";
    const requestedPort = 18790 + (process.pid % 977);

    const { startEmbeddedServer } = await import(pathToFileURL(embeddedBundle).href);
    const coworker = await createCoworker(coworkersDir, {
      name: "Integration Coworker",
      role: "Integration",
      mission: "Prove the composition",
    });

    const handle = await startEmbeddedServer({
      host: "127.0.0.1",
      port: requestedPort,
      corsOrigins: ["*"],
      approvalMode: "auto",
      configPath,
      workspaces: [],
      token: clientToken,
      hostToken,
      manageOpencode: false,
    });

    try {
      const health = await (await fetch(`${handle.url}/health`)).json();
      assert.equal(health.ok, true);

      // Owner token issuance is the same bootstrap the app performs.
      const tokenResponse = await fetch(`${handle.url}/tokens`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-OpenWork-Host-Token": hostToken,
        },
        body: JSON.stringify({ scope: "owner", label: "coworker platform test" }),
      });
      assert.equal(tokenResponse.status, 201);
      const ownerToken = (await tokenResponse.json()).token;
      assert.ok(typeof ownerToken === "string" && ownerToken.length > 0);

      // Register the coworker directory exactly like the app's main process does.
      const createResponse = await fetch(`${handle.url}/workspaces/local`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-OpenWork-Host-Token": hostToken,
        },
        body: JSON.stringify({ folderPath: coworker.path, name: coworker.name, preset: "minimal" }),
      });
      assert.equal(createResponse.status, 201);
      const created = await createResponse.json();
      assert.ok(typeof created.activeId === "string" && created.activeId.length > 0);

      const listed = await (
        await fetch(`${handle.url}/workspaces`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        })
      ).json();
      const workspaces = Array.isArray(listed?.items) ? listed.items : [];
      const registered = workspaces.find((workspace) => workspace.id === created.activeId);
      assert.ok(registered, "created workspace should be listed");
      assert.equal(path.resolve(registered.path), path.resolve(coworker.path));

      // The platform reference round-trips through coworker.md frontmatter.
      await updateCoworker(coworkersDir, coworker.slug, { workspaceId: created.activeId });
      const reread = await getCoworker(coworkersDir, coworker.slug);
      assert.equal(reread.workspaceId, created.activeId);

      // Registration is idempotent for the same directory: same workspace id.
      const repeatResponse = await fetch(`${handle.url}/workspaces/local`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-OpenWork-Host-Token": hostToken,
        },
        body: JSON.stringify({ folderPath: coworker.path, name: coworker.name, preset: "minimal" }),
      });
      assert.equal(repeatResponse.status, 201);
      const repeat = await repeatResponse.json();
      assert.equal(repeat.activeId, created.activeId);
    } finally {
      await handle.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
);
