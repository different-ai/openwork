import test from "node:test";
import assert from "node:assert/strict";

import path from "node:path";

import { reconcileInjectedUserEnv, resolveUserEnvFilePath } from "./runtime.mjs";
import { applyDesktopFreeBuildSettings } from "./desktop-free-release.mjs";

test("an installed build opt-out survives user environment changes and runtime restarts", async () => {
  const processEnv = { OPENWORK_DISABLE_FREE_INFERENCE: "0" };
  await applyDesktopFreeBuildSettings({ appVersion: "1.2.3", environment: processEnv,
    importGenerated: async () => ({ version: "1.2.3", disabled: true }),
  });
  const inheritedEnv = { ...processEnv };
  const injected = reconcileInjectedUserEnv({ processEnv, inheritedEnv,
    userEnv: { OPENWORK_DISABLE_FREE_INFERENCE: "0" },
  });
  assert.equal(processEnv.OPENWORK_DISABLE_FREE_INFERENCE, "1");
  reconcileInjectedUserEnv({ processEnv, inheritedEnv, userEnv: {}, previouslyInjectedKeys: injected });
  assert.equal(processEnv.OPENWORK_DISABLE_FREE_INFERENCE, "1");
});

test("resolves the user env store from the effective desktop profile", () => {
  assert.equal(
    resolveUserEnvFilePath({
      HOME: "/Users/example",
      XDG_CONFIG_HOME: "/tmp/openwork-dev-profile/config",
    }),
    path.join("/tmp/openwork-dev-profile/config", "openwork", "env.json"),
  );
});

test("removes a user env key from the long-lived desktop process after deletion", () => {
  const inheritedEnv = { PATH: "/usr/bin" };
  const processEnv = {
    ...inheritedEnv,
    ANTHROPIC_API_KEY: "previously-injected",
  };

  const nextKeys = reconcileInjectedUserEnv({
    processEnv,
    inheritedEnv,
    userEnv: {},
    previouslyInjectedKeys: new Set(["ANTHROPIC_API_KEY"]),
  });

  assert.equal(processEnv.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual([...nextKeys], []);
});

test("restores an inherited value when a user env override is removed", () => {
  const inheritedEnv = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "inherited",
  };
  const processEnv = {
    ...inheritedEnv,
    ANTHROPIC_API_KEY: "user-store-value",
  };

  reconcileInjectedUserEnv({
    processEnv,
    inheritedEnv,
    userEnv: {},
    previouslyInjectedKeys: new Set(["ANTHROPIC_API_KEY"]),
  });

  assert.equal(processEnv.ANTHROPIC_API_KEY, "inherited");
});

test("refreshes an injected user env key when its stored value changes", () => {
  const inheritedEnv = { PATH: "/usr/bin" };
  const processEnv = {
    ...inheritedEnv,
    ANTHROPIC_API_KEY: "old-value",
  };

  reconcileInjectedUserEnv({
    processEnv,
    inheritedEnv,
    userEnv: { ANTHROPIC_API_KEY: "new-value" },
    previouslyInjectedKeys: new Set(["ANTHROPIC_API_KEY"]),
  });

  assert.equal(processEnv.ANTHROPIC_API_KEY, "new-value");
});

test("dev child env reconciliation preserves an inherited OPENCODE_DB override", () => {
  const inheritedEnv = {
    OPENWORK_DEV_MODE: "1",
    OPENCODE_DB: "/tmp/installed-production/opencode.db",
  };
  const processEnv = { ...inheritedEnv };

  reconcileInjectedUserEnv({
    processEnv,
    inheritedEnv,
    userEnv: {},
    previouslyInjectedKeys: new Set(),
  });

  assert.equal(processEnv.OPENCODE_DB, "/tmp/installed-production/opencode.db");
});
