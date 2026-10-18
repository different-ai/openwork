import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Seed } from "@openwork/env";
import { backgroundTasksShimmer } from "./background-tasks-shimmer.ts";
import { modelRemovalHttpFixture } from "./model-removal-cdp.ts";

/** A real background process; only running-command list reads can be refused. */
export async function backgroundTaskRecovery(seed: Seed) {
  const base = await backgroundTasksShimmer(seed);
  const neighbor = await seed.session(base.app, { title: "Separate project" });
  await writeFile(join(base.app.workspaceRoot, "scripts/export-report.sh"), '#!/bin/sh\nwhile [ ! -f .release/export-report ]; do sleep 0.2; done\necho "Report export needs review"\nexit 2\n');
  const mock = base.app.mocks.agent;
  if (!mock) throw new Error("Missing background model fixture");
  const scripted = await fetch(`${mock.url}/admin/agent-workloads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workloads: [
    { promptMarker: base.report.prompt, latestUserTurn: true, finalReply: base.report.started, steps: [{ tool: "shell", arguments: { command: base.report.command, description: "Export report", background: true } }] },
    { promptMarker: "Report export needs review", latestUserTurn: true, finalReply: "The report export failed. Review the command's output before trying again.", steps: [] },
  ] }) });
  if (!scripted.ok) throw new Error("Could not arrange background failure model");
  let failLists = false;
  let refusedReads = 0;
  const fixture = await modelRemovalHttpFixture(base.app, ["*/opencode2/api/shell*"], () => {
    if (!failLists) return undefined;
    refusedReads++;
    return Response.json({ error: "fixture_unavailable" }, { status: 503 });
  });
  return { ...base, neighbor,
    failChecks() { failLists = true; }, restoreChecks() { failLists = false; },
    refusedReads() { fixture.check(); return refusedReads; },
    [Symbol.asyncDispose]: () => fixture[Symbol.asyncDispose](),
  };
}
