import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describeEngineFindings, diagnoseEngine, engineNeverAnswered, engineRequests } from "../scripts/engine-diagnosis.mjs";

// Lines shaped as the packaged desktop logged them during the 2026-10-13 outage.
const outage = `GET /health 200 1ms
GET /workspace/ws_1d9ce5670a62/opencode2/api/session/active 502 5005ms (opencode)
GET /workspace/ws_1d9ce5670a62/opencode2/api/model 499 10000ms (opencode)
GET /workspace/ws_1d9ce5670a62/opencode2/api/mcp 499 10019ms (opencode)
GET /workspace/ws_1d9ce5670a62/opencode2/api/session 499 14999ms (opencode)
Engine folder warm-up failed.`;
// A healthy boot: one early 502 while the engine starts, then answers.
const healthy = `GET /workspace/ws_189d62500d82/opencode2/api/session/active 502 5005ms (opencode)
GET /workspace/ws_189d62500d82/opencode2/api/mcp 200 6541ms (opencode)
GET /workspace/ws_189d62500d82/opencode2/api/model 200 6544ms (opencode)
GET /workspace/ws_189d62500d82/opencode2/api/session 200 6545ms (opencode)`;

test("engine requests are read from desktop log lines", () => {
  assert.deepEqual(engineRequests(outage).map((request) => request.status), [502, 499, 499, 499]);
  assert.equal(engineRequests("GET /workspace/ws_1/events 200 1ms").length, 0);
});

test("only a log where every engine request failed counts as an engine that never answered", () => {
  assert.equal(engineNeverAnswered(engineRequests(outage)), true);
  assert.equal(engineNeverAnswered(engineRequests(healthy)), false);
  // Too little evidence to blame the engine.
  assert.equal(engineNeverAnswered(engineRequests("GET /workspace/ws_1/opencode2/api/session 502 5005ms (opencode)")), false);
});

test("a failed run names the desktop whose engine never answered and shows that engine's errors", () => {
  const root = mkdtempSync(join(tmpdir(), "engine-diagnosis-"));
  try {
    const boot = join(root, "desktop-boot");
    mkdirSync(boot, { recursive: true });
    writeFileSync(join(boot, "app-smoke-1-6959-electron.log"), outage);
    writeFileSync(join(boot, "app-smoke-1-6959-opencode-2026-10-13T203110.log"), "INFO service=server listening\nERROR service=provider failed to load models\n");
    writeFileSync(join(boot, "app-smoke-2-7000-electron.log"), healthy);
    const findings = diagnoseEngine(root);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].log, join("desktop-boot", "app-smoke-1-6959-electron.log"));
    assert.deepEqual(findings[0].statuses, [499, 502]);
    assert.deepEqual(findings[0].engineErrors, ["ERROR service=provider failed to load models"]);
    const text = describeEngineFindings(findings);
    assert.match(text, /never answered in desktop-boot\/app-smoke-1-6959-electron\.log: all 4 engine requests failed \(HTTP 499, 502; slowest 15s\)/);
    assert.match(text, /failed to load models/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("no logs means no finding", () => {
  assert.deepEqual(diagnoseEngine(join(tmpdir(), "does-not-exist-engine-diagnosis")), []);
});
