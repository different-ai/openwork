import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createObservabilityConsoleBridge,
  createObservabilityRendererTarget,
  resolveObservabilityConsoleEnabled,
} from "./observability-console-bridge.mjs";

describe("desktop observability console bridge", () => {
  it("does not claim delivery until the renderer document is ready", () => {
    const records = [];
    const window = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (eventName, payload) => records.push({ eventName, payload }),
      },
    };
    const target = createObservabilityRendererTarget({ getWindow: () => window });

    assert.equal(target.send({ line: "before preload" }), false);
    target.markReady();
    assert.equal(target.send({ line: "after preload" }), true);
    target.markLoading();
    assert.equal(target.send({ line: "during reload" }), false);
    assert.deepEqual(records, [{
      eventName: "openwork:observability-console",
      payload: { line: "after preload" },
    }]);
  });

  it("uses explicit prompt logging before the visible Developer Mode preference", () => {
    assert.equal(resolveObservabilityConsoleEnabled({ openworkPromptLog: true }, { OPENWORK_PROMPT_LOG: "0" }), false);
    assert.equal(resolveObservabilityConsoleEnabled({ openworkPromptLog: false }, { OPENWORK_PROMPT_LOG: "yes" }), true);
    assert.equal(resolveObservabilityConsoleEnabled({ openworkPromptLog: true }, { OPENWORK_PROMPT_LOG: "invalid" }), false);
    assert.equal(resolveObservabilityConsoleEnabled({ openworkPromptLog: true }, {}), true);
    assert.equal(resolveObservabilityConsoleEnabled({ openworkPromptLog: false }, {}), false);
    assert.equal(resolveObservabilityConsoleEnabled({}, { OPENWORK_OBSERVABILITY: "metadata" }), true);
    assert.equal(resolveObservabilityConsoleEnabled({}, { OPENWORK_OBSERVABILITY: "exact" }), true);
    assert.equal(resolveObservabilityConsoleEnabled({ openworkDeveloperMode: true }, { OPENWORK_OBSERVABILITY: "off" }), false);
    assert.equal(resolveObservabilityConsoleEnabled({ openworkDeveloperMode: true }, { OPENWORK_OBSERVABILITY: "invalid" }), false);
  });

  it("forwards complete OpenWork observability lines only while enabled", () => {
    const records = [];
    const bridge = createObservabilityConsoleBridge({ send: (record) => records.push(record) });
    bridge.push("[openwork][context] disabled\n");
    bridge.setEnabled(true);
    bridge.push("unrelated stderr\n[openwork][context] trace=pt_000001");
    bridge.push(" ok\n[opencode:stderr] raw engine output\n");
    bridge.push("[opencode:stderr] [openwork][agent-prompt] metadata record\n");
    bridge.setEnabled(false);
    bridge.push("[openwork][context] disabled-again\n");

    assert.deepEqual(records, [
      { line: "[openwork][context] trace=pt_000001 ok", truncated: false },
      { line: "[opencode:stderr] [openwork][agent-prompt] metadata record", truncated: false },
    ]);
  });

  it("bounds a newline-free diagnostic without retaining its tail", () => {
    const records = [];
    const bridge = createObservabilityConsoleBridge({
      send: (record) => records.push(record),
      maxLineChars: 48,
    });
    bridge.setEnabled(true);
    bridge.push(`[opencode:stderr] [openwork][context] ${"x".repeat(80)}`);
    bridge.push("discarded-tail\n[openwork][context] recovered\n");

    assert.deepEqual(records, [
      {
        line: "[openwork][observability-bridge] line omitted: reason=max-line-chars limit=48",
        truncated: true,
      },
      { line: "[openwork][context] recovered", truncated: false },
    ]);
  });

  it("bounds an oversized complete line delivered in one chunk", () => {
    const records = [];
    const bridge = createObservabilityConsoleBridge({
      send: (record) => records.push(record),
      maxLineChars: 48,
    });
    bridge.setEnabled(true);
    bridge.push(`[openwork][context] ${"x".repeat(80)}\n[openwork][context] recovered\n`);

    assert.deepEqual(records, [
      {
        line: "[openwork][observability-bridge] line omitted: reason=max-line-chars limit=48",
        truncated: true,
      },
      { line: "[openwork][context] recovered", truncated: false },
    ]);
  });

  it("replays only one content-free observer initialization record", () => {
    const records = [];
    let available = false;
    const bridge = createObservabilityConsoleBridge({
      send: (record) => {
        if (!available) return false;
        records.push(record);
        return true;
      },
    });
    bridge.setEnabled(true);
    bridge.push("[opencode:stderr] raw prompt must not be retained\n");
    bridge.push("[opencode:stderr] [openwork][agent-prompt] observer initialized: at=2026-07-23T00:00:00.000Z, level=metadata, enabled=true, exact=false, source=OPENWORK_DESKTOP_DEV_MODE\n");
    available = true;

    assert.equal(bridge.replaySafeInitialization(), true);
    assert.equal(bridge.replaySafeInitialization(), false);
    assert.deepEqual(records, [{
      line: "[opencode:stderr] [openwork][agent-prompt] observer initialized: at=2026-07-23T00:00:00.000Z, level=metadata, enabled=true, exact=false, source=OPENWORK_DESKTOP_DEV_MODE",
      truncated: false,
    }]);
    assert.equal(records.some((record) => record.line.includes("raw prompt")), false);
  });
});
