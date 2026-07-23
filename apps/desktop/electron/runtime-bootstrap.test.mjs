import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRuntimeBootstrapCoordinator } from "./runtime-bootstrap.mjs";

describe("createRuntimeBootstrapCoordinator", () => {
  it("reconciles a stored-on renderer preference after eager relaunch boot", async () => {
    const calls = [];
    let releaseEagerBoot = () => {};
    const eagerBootBlocked = new Promise((resolve) => {
      releaseEagerBoot = () => resolve(undefined);
    });
    const ensureRuntimeBootstrap = createRuntimeBootstrapCoordinator(async (options) => {
      calls.push(options.openworkPromptLog);
      if (calls.length === 1) await eagerBootBlocked;
      return { ok: true, openworkPromptLog: options.openworkPromptLog };
    });

    const eagerResult = ensureRuntimeBootstrap();
    const storedOnResult = ensureRuntimeBootstrap({ openworkPromptLog: true });

    await Promise.resolve();
    assert.deepEqual(calls, [false]);
    releaseEagerBoot();

    assert.deepEqual(await eagerResult, { ok: true, openworkPromptLog: false });
    assert.deepEqual(await storedOnResult, { ok: true, openworkPromptLog: true });
    assert.deepEqual(calls, [false, true]);
  });

  it("deduplicates bootstrap requests for the same preference", async () => {
    const calls = [];
    const ensureRuntimeBootstrap = createRuntimeBootstrapCoordinator(async (options) => {
      calls.push(options.openworkPromptLog);
      return { ok: true };
    });

    const first = ensureRuntimeBootstrap({ openworkPromptLog: true });
    const second = ensureRuntimeBootstrap({ openworkPromptLog: true });

    assert.equal(second, first);
    await second;
    assert.deepEqual(calls, [true]);
  });

  it("reconciles metadata-only Developer Mode separately from exact prompt logging", async () => {
    const calls = [];
    const ensureRuntimeBootstrap = createRuntimeBootstrapCoordinator(async (options) => {
      calls.push({
        developerMode: options.openworkDeveloperMode,
        exact: options.openworkPromptLog,
      });
      return { ok: true };
    });

    await ensureRuntimeBootstrap();
    await ensureRuntimeBootstrap({ openworkDeveloperMode: true, openworkPromptLog: false });

    assert.deepEqual(calls, [
      { developerMode: false, exact: false },
      { developerMode: true, exact: false },
    ]);
  });

  it("still applies a changed preference after an earlier bootstrap failure", async () => {
    const calls = [];
    const ensureRuntimeBootstrap = createRuntimeBootstrapCoordinator(async (options) => {
      calls.push(options.openworkPromptLog);
      if (calls.length === 1) throw new Error("initial boot failed");
      return { ok: true, openworkPromptLog: options.openworkPromptLog };
    });

    const failed = ensureRuntimeBootstrap();
    const recovered = ensureRuntimeBootstrap({ openworkPromptLog: true });

    assert.deepEqual(await failed, { ok: false, error: "initial boot failed" });
    assert.deepEqual(await recovered, { ok: true, openworkPromptLog: true });
    assert.deepEqual(calls, [false, true]);
  });
});
