import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openworkInstallMarkerPaths, resolveFreshInstallEngine } from "../electron/runtime.mjs";

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

test("any file an earlier OpenWork run left behind marks an update, which also uses v2", () => {
  withProfile(({ markerPaths }) => {
    for (const marker of markerPaths) {
      assert.equal(resolveFreshInstallEngine({ markerPaths, env: {}, exists: (filePath) => filePath === marker }), "v2", marker);
    }
  });
});

test("an updated install with a server config uses v2", () => {
  withProfile(({ dir, markerPaths }) => {
    const serverConfig = join(dir, "config", "openwork", "server.json");
    assert.ok(markerPaths.includes(serverConfig));
    mkdirSync(join(dir, "config", "openwork"), { recursive: true });
    writeFileSync(serverConfig, "{}");
    assert.equal(resolveFreshInstallEngine({ markerPaths, env: {} }), "v2");
  });
});

test("a retired OPENWORK_ENGINE_V2_PREVIEW override cannot select v1", () => {
  withProfile(({ markerPaths }) => {
    assert.equal(resolveFreshInstallEngine({ markerPaths, env: { OPENWORK_ENGINE_V2_PREVIEW: "0" } }), "v2");
  });
});
