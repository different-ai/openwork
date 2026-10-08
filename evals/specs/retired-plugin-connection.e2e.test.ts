import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { retiredPluginConnection, type IndexEntry } from "../worlds/retired-plugin-connection.ts";

// Browser-less: the fix is in what Den publishes to members' agents and
// desktops (the connection index, the usable list, and execute_capability).
const test = spec.world(retiredPluginConnection, {
  resources: { surfaces: [], services: ["den", "mock"] },
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  timeout: 600_000,
});

function listed(entries: IndexEntry[], connectionId: string): string {
  const entry = entries.find((candidate) => candidate.connectionId === connectionId);
  return entry ? `listed (exposeDirectly ${entry.exposeDirectly})` : "absent";
}

test("an admin deletes a connector's plugin and members' agents stop getting its tools, until it is restored", { tags: ["agent-flow"] }, async ({ world, step, evidence }) => {
  const { crm, notes } = world;

  await step("given: a plugin's CRM server is also shared with everyone and exposed to members' desktops", async () => {
    const view = await world.memberView();
    const before = (await crm.mock.toolCalls()).length;
    const run = await world.memberRuns(crm.id, crm.tool, "before-archive");
    const calls = await crm.mock.toolCalls({ atLeast: before + 1, timeoutMs: 30_000 });
    const ok = listed(view.ordinary, crm.id) === "listed (exposeDirectly true)"
      && listed(view.appHost, crm.id) !== "absent" && view.usable.includes(crm.id)
      && !run.isError && calls.length === before + 1;
    evidence.recordAssertionEvidence(
      "The member's agent sees and can use the plugin's CRM server",
      `"${crm.name}": ordinary index ${listed(view.ordinary, crm.id)}; desktop index ${listed(view.appHost, crm.id)}; usable list ${view.usable.includes(crm.id) ? "includes it" : "omits it"}; ${crm.tool} → ${run.isError ? `error ${run.error}` : "ok"}; CRM server received ${calls.length - before} call`,
      ok,
    );
    expect(ok).toBe(true);
  });

  await step("when: the admin deletes the plugin from the Library", async () => {
    const status = await world.archivePlugin();
    evidence.recordAssertionEvidence("The plugin is archived", `POST /v1/plugins/:id/archive → HTTP ${status} for "${world.pluginName}"`, status === 200);
    expect(status).toBe(200);
  });

  await step("then: the member's agents and desktop no longer get the CRM server", async () => {
    const view = await world.memberView();
    evidence.recordAssertionEvidence(
      "The CRM server leaves every member-facing list",
      `ordinary index ${listed(view.ordinary, crm.id)}; desktop index ${listed(view.appHost, crm.id)}; usable list ${view.usable.includes(crm.id) ? "includes it" : "omits it"} (${view.ordinary.length} / ${view.appHost.length} / ${view.usable.length} entries left)`,
      listed(view.ordinary, crm.id) === "absent" && listed(view.appHost, crm.id) === "absent" && !view.usable.includes(crm.id),
    );
    expect(listed(view.ordinary, crm.id)).toBe("absent");
    expect(listed(view.appHost, crm.id)).toBe("absent");
    expect(view.usable).not.toContain(crm.id);
  });

  await step("then: running its tool is refused and the CRM server receives nothing", async () => {
    const before = (await crm.mock.toolCalls()).length;
    const run = await world.memberRuns(crm.id, crm.tool, "after-archive");
    const after = (await crm.mock.toolCalls()).length;
    evidence.recordAssertionEvidence(
      "The deleted plugin's tool cannot run",
      `${crm.tool} → ${run.isError ? `error ${run.error || run.text.slice(0, 80)}` : "ran"}; CRM server received ${after - before} new calls`,
      run.isError && after === before,
    );
    expect(run.isError).toBe(true);
    expect(after).toBe(before);
  });

  await step("boundary: the admin's own Notes connection stays available to the member", async () => {
    const view = await world.memberView();
    const before = (await notes.mock.toolCalls()).length;
    const run = await world.memberRuns(notes.id, notes.tool, "boundary");
    const calls = await notes.mock.toolCalls({ atLeast: before + 1, timeoutMs: 30_000 });
    const ok = listed(view.ordinary, notes.id) === "listed (exposeDirectly true)" && view.usable.includes(notes.id)
      && !run.isError && calls.length === before + 1;
    evidence.recordAssertionEvidence(
      "Unrelated connections are unaffected",
      `"${notes.name}": ordinary index ${listed(view.ordinary, notes.id)}; usable list ${view.usable.includes(notes.id) ? "includes it" : "omits it"}; ${notes.tool} → ${run.isError ? `error ${run.error}` : "ok"}; Notes server received ${calls.length - before} call`,
      ok,
    );
    expect(ok).toBe(true);
  });

  await step("after: restoring the plugin brings the CRM server back for the member", async () => {
    const status = await world.restorePlugin();
    const view = await world.memberView();
    const before = (await crm.mock.toolCalls()).length;
    const run = await world.memberRuns(crm.id, crm.tool, "after-restore");
    const calls = await crm.mock.toolCalls({ atLeast: before + 1, timeoutMs: 30_000 });
    const ok = status === 200 && listed(view.ordinary, crm.id) === "listed (exposeDirectly true)"
      && listed(view.appHost, crm.id) !== "absent" && view.usable.includes(crm.id)
      && !run.isError && calls.length === before + 1;
    evidence.recordAssertionEvidence(
      "Restore makes the CRM server usable again",
      `restore → HTTP ${status}; ordinary index ${listed(view.ordinary, crm.id)}; desktop index ${listed(view.appHost, crm.id)}; ${crm.tool} → ${run.isError ? `error ${run.error}` : "ok"}; CRM server received ${calls.length - before} call`,
      ok,
    );
    expect(ok).toBe(true);
  });
});
