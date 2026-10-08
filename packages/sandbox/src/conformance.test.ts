import { test } from "node:test"
import { createFakeProvider, sandboxProviderConformanceCases } from "./testing/index.js"

// The fake is the reference provider: every case must hold for it, so the
// cases themselves stay honest before they run against a real provider.
for (const conformanceCase of sandboxProviderConformanceCases(() => createFakeProvider())) {
  test(`fake provider: ${conformanceCase.name}`, conformanceCase.run)
}

import assert from "node:assert/strict"
import { sandboxBlockConformanceCases } from "./testing/index.js"
for (const c of sandboxBlockConformanceCases(() => createFakeProvider({
  onRun(spec) {
    assert.equal(spec.cwd, "/tmp")
    assert.equal(spec.env?.OPENWORK_CHECK, "value with ' quotes $ and spaces")
    return { exitCode: 7, stdout: spec.env?.OPENWORK_CHECK ?? "", stderr: "stderr" }
  },
}), ["run", "files", "pause", "snapshots"])) test(`fake provider: ${c.name}`, c.run)
