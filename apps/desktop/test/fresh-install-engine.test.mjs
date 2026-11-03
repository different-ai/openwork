import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openworkInstallMarkerPaths, resolveDesktopEngineAutoUpgrade, resolveFreshInstallEngine } from "../electron/runtime.mjs";

function withProfile(run) {
  const dir = mkdtempSync(join(tmpdir(), "openwork-fresh-install-"));
  try {
    const markerPaths = openworkInstallMarkerPaths({
      userDataDir: join(dir, "userData"),
      serverConfigPath: join(dir, "config", "openwork", "server.json"),
      env: {},
    });
    run({ dir, markerPaths });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a profile with no earlier OpenWork state is a new install and starts on v2", () => {
  withProfile(({ markerPaths }) => {
    assert.equal(resolveFreshInstallEngine({ markerPaths, env: {} }), "v2");
  });
});

test("any file an earlier OpenWork run left behind marks an update, which keeps its engine", () => {
  withProfile(({ markerPaths }) => {
    for (const marker of markerPaths) {
      assert.equal(resolveFreshInstallEngine({ markerPaths, env: {}, exists: (filePath) => filePath === marker }), undefined, marker);
    }
  });
});

test("an updated install with a server config stays on its engine", () => {
  withProfile(({ dir, markerPaths }) => {
    const serverConfig = join(dir, "config", "openwork", "server.json");
    assert.ok(markerPaths.includes(serverConfig));
    mkdirSync(join(dir, "config", "openwork"), { recursive: true });
    writeFileSync(serverConfig, "{}");
    assert.equal(resolveFreshInstallEngine({ markerPaths, env: {} }), undefined);
  });
});

test("an explicit OPENWORK_ENGINE_V2_PREVIEW always wins over the new-install default", () => {
  withProfile(({ markerPaths }) => {
    assert.equal(resolveFreshInstallEngine({ markerPaths, env: { OPENWORK_ENGINE_V2_PREVIEW: "0" } }), undefined);
  });
});

test("new desktop versions move existing v1 installs to v2 in the background unless the engine is pinned", () => {
  assert.equal(resolveDesktopEngineAutoUpgrade({}), true);
  // Test harnesses and support pin an engine explicitly; that keeps today's behavior.
  assert.equal(resolveDesktopEngineAutoUpgrade({ OPENWORK_ENGINE_V2_PREVIEW: "0" }), undefined);
  assert.equal(resolveDesktopEngineAutoUpgrade({ OPENWORK_ENGINE_V2_PREVIEW: "1" }), undefined);
  assert.equal(resolveDesktopEngineAutoUpgrade({ OPENWORK_ENGINE_AUTO_UPGRADE: "0" }), undefined);
  assert.equal(resolveDesktopEngineAutoUpgrade({ OPENWORK_ENGINE_AUTO_UPGRADE: "1" }), undefined);
});
