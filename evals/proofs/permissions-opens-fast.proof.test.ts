import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { permissionsOpensFast } from "../worlds/permissions-opens-fast.ts";

const test = spec.world(permissionsOpensFast, {
  timeout: 600_000,
  resources: { surfaces: ["desktop"], services: ["den"], nativeReason: "The packaged desktop forwards organization policy to its embedded server and owns the sandbox process tree." },
});
const coldBudget = 2_000;
const warmBudget = 600;
const checking = "Checking your organization's settings…";
const tti = (value: number | undefined) => value === undefined ? "not interactive" : `${Math.round(value)} ms`;
const forbidden = (notices: Record<string, unknown>) => Object.keys(notices).filter(text => /\bloading\b|disconnected|pulling in the latest messages/i.test(text));

test("a signed-in member with twelve workspaces can open Permissions while organization settings are slow", async ({ world, user, agent, probe, step, evidence }) => {
  const open = () => agent.run("route.settings.authorized_folders");
  const leave = async () => { await user.click({ role: "button", label: "Back to app" }); await user.see("composer", { timeoutMs: 30_000 }); };
  const measure = (captureMs: number, limitMs: number) => Promise.all([world.measure(captureMs, limitMs), open()]).then(([result]) => result);
  const status = async () => {
    const result = await probe.desktopApi(world.statusPath);
    const body = result.body;
    return result.status === 200 && body && typeof body === "object" && "state" in body && typeof body.state === "string" ? body.state : "unavailable";
  };
  let beforeStatus = "";
  let beforeProcesses: number[] = [];
  await step("before: a slow organization connection left the member waiting for Permissions", async () => {
    await user.see("composer", { timeoutMs: 30_000 });
    beforeStatus = await status();
    beforeProcesses = await world.processes();
    const ok = world.workspaceCount >= 12 && beforeStatus !== "unavailable" && beforeProcesses.length === 0;
    evidence.recordAssertionEvidence("The member has at least twelve registered workspaces and no sandbox process", `Fresh legacy packaged rerun: 11,690 ms at +150 ms and 19,974 ms at +400 ms (12 workspaces); neither meets the cold budget. This fixture: ${world.workspaceCount} workspaces, sandbox ${beforeStatus}, ${beforeProcesses.length} processes.`, ok);
    await user.screenshot();
    expect(ok).toBe(true);
  });
  for (const [label, budget] of [["first open", coldBudget], ["second open", warmBudget]] satisfies [string, number][]) {
    await step(`when the member opens Permissions for the ${label === "first open" ? "first" : "second"} time`, async () => {
      if (label === "second open") await leave();
      const offset = world.proxy.requests.length;
      world.proxy.setLatency(400);
      const result = await measure(5_000, 5_500);
      const processes = await world.processes();
      const afterStatus = await status();
      const delayed = world.proxy.requests.slice(offset).filter(row => (row.durationMs ?? 0) >= 400).length;
      const notices = forbidden(result.notices);
      const ok = result.marks.tti !== undefined && result.marks.tti <= budget && notices.length === 0 && afterStatus === beforeStatus && processes.length === 0 && delayed > 0;
      evidence.recordAssertionEvidence(`Both sections work at the ${label} without starting a sandbox`, `TTI ${tti(result.marks.tti)} / ${budget} ms; ${delayed} delayed Den responses; notices: ${notices.join(", ") || "none"}; sandbox ${beforeStatus} → ${afterStatus}, ${processes.length} processes.`, ok);
      await user.screenshot();
      expect(ok).toBe(true);
    });
  }
  await step("then Permissions still works when the organization connection stops answering", async () => {
    await leave();
    const offset = world.proxy.requests.length;
    world.proxy.setLatency("hang");
    const result = await measure(2_100, 3_000);
    const requests = world.proxy.requests.slice(offset);
    const held = requests.filter(row => row.durationMs === undefined).length;
    const notice = Object.keys(result.notices).includes(checking);
    const notices = forbidden(result.notices);
    const ok = held > 0 && result.marks.tti !== undefined && result.marks.tti <= coldBudget && notice && notices.length === 0;
    evidence.recordAssertionEvidence("The organization check is quiet and does not block either section", `TTI ${tti(result.marks.tti)} / ${coldBudget} ms; ${held} requests still unanswered; organization check ${notice ? "shown" : "not shown"}; blocking notices: ${notices.join(", ") || "none"}.`, ok);
    await user.screenshot();
    expect(ok).toBe(true);
  });
  await step("after: a timed-out local settings read offers Retry instead of spinning forever", async () => {
    world.proxy.setLatency(0);
    await leave();
    // Reload to evict the prior settings result; the fault must hit a fresh request.
    await user.reload();
    await user.see("composer", { timeoutMs: 45_000 });
    const fault = await world.hangSettings();
    try {
      const result = await measure(8_000, 11_000);
      const starts = await fault(false);
      const shown = result.marks["sandbox-settings-error-with-retry"];
      const fetchStart = starts.find(start => start >= result.t);
      const afterRequest = shown === undefined || fetchStart === undefined ? undefined : result.t + shown - fetchStart;
      const add = result.marks["add-enabled"];
      const ok = afterRequest !== undefined && afterRequest >= 8_000 && afterRequest <= 9_000 && shown !== undefined && add !== undefined && add < shown;
      evidence.recordAssertionEvidence("A slow local settings read has an independent, usable recovery action", `${starts.length} held settings reads; plain error and Retry ${tti(afterRequest)} after that request (${tti(shown)} from navigation); Add folder ${tti(add)}.`, ok);
      await user.screenshot();
      expect(ok).toBe(true);
    } finally { await fault(true); }
  });
});
