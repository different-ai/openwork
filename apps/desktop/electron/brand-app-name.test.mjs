import assert from "node:assert/strict";
import test from "node:test";

import { applyBrandAppName } from "./brand-app-name.mjs";

test("updates the macOS process and Electron application name before rebuilding the native menu", () => {
  const calls = [];
  const appName = applyBrandAppName("  Acme Work  ", {
    fallbackName: "OpenWork",
    platform: "darwin",
    updateElectronAppName: true,
    runtimeProcess: {
      get title() { return ""; },
      set title(name) { calls.push(["process", name]); },
    },
    app: { setName: (name) => calls.push(["app", name]) },
    applicationMenu: { setAppName: (name) => calls.push(["menu", name]) },
    window: { setTitle: (name) => calls.push(["window", name]) },
  });

  assert.equal(appName, "Acme Work");
  assert.deepEqual(calls, [
    ["process", "Acme Work"],
    ["app", "Acme Work"],
    ["menu", "Acme Work"],
    ["window", "Acme Work"],
  ]);
});

test("preserves the existing Windows live-update behavior", () => {
  const calls = [];
  const appName = applyBrandAppName("Acme Work", {
    fallbackName: "OpenWork",
    platform: "win32",
    updateElectronAppName: false,
    runtimeProcess: {
      get title() { return ""; },
      set title(name) { calls.push(["process", name]); },
    },
    app: { setName: (name) => calls.push(["app", name]) },
    applicationMenu: { setAppName: (name) => calls.push(["menu", name]) },
    window: { setTitle: (name) => calls.push(["window", name]) },
  });

  assert.equal(appName, "Acme Work");
  assert.deepEqual(calls, [
    ["menu", "Acme Work"],
    ["window", "Acme Work"],
  ]);
});

test("keeps the startup fallback and branded-name limit on every platform", () => {
  const appliedNames = [];
  const dependencies = {
    fallbackName: "OpenWork",
    platform: "win32",
    updateElectronAppName: true,
    runtimeProcess: {
      get title() { return ""; },
      set title(name) { appliedNames.push(`process:${name}`); },
    },
    app: { setName: (name) => appliedNames.push(name) },
    applicationMenu: { setAppName: () => undefined },
  };

  assert.equal(applyBrandAppName(null, dependencies), "OpenWork");
  assert.equal(applyBrandAppName("A".repeat(80), dependencies), "A".repeat(64));
  assert.deepEqual(appliedNames, ["OpenWork", "A".repeat(64)]);
});
