/**
 * Repro attempts for the field report "failed authorization / asks me to
 * reconnect even though the tools/MCPs are connected": a member with many
 * workspaces (one per customer) who switches quickly between sessions across
 * those workspaces starts seeing auth failures and reconnect prompts.
 *
 * Three attempts, from broad to narrow:
 *  1. Considerable scale — ~8 workspaces, round-robin switching storms.
 *  2. Marten-scale (6 workspaces) switching while Den is overloaded
 *     (latency + 429 bursts) and while Den briefly answers 401.
 *  3. A two-workspace rapid-toggle race with zero dwell time.
 *
 * Every attempt asserts the same coherence contract and its negative half:
 * the Den session token must never disappear, the active organization must
 * not change, Connect must stay (or recover to) available, no workspace may
 * be lost, and the wire log must show no non-injected 401/403 from Den.
 */
import { expect } from "vitest";
import { control, evalIn, go, waitFor } from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/test-evidence";
import {
  app,
  eventually,
  faultProxy,
  localMysqlIsRunning,
  needs,
  readCloudMcpHealth,
  readConnectState,
  readDenClientState,
  server,
  sleep,
  test,
} from "@openwork/testkit";
import type { App, DenClientState, FaultProxy, FaultRequest } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const daytonaEnabled = process.env.OPENWORK_EVAL_DAYTONA === "1";
const configuredDen = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const localMysqlRequired = !daytonaEnabled && !configuredDen;
const mysqlOpen = await localMysqlIsRunning();
const runnable = e2eTestsEnabled && (!localMysqlRequired || mysqlOpen);

const skipSuffix = !e2eTestsEnabled
  ? " skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1"
  : localMysqlRequired && !mysqlOpen
    ? " skipped — needs MySQL on 127.0.0.1:3306"
    : "";

/** Total workspace count for the scale attempt. */
const STORM_WORKSPACE_TOTAL = (() => {
  const raw = Number(process.env.OPENWORK_EVAL_WORKSPACE_STORM_COUNT ?? "8");
  return Number.isInteger(raw) && raw >= 2 ? raw : 8;
})();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface WorkspaceListing {
  ids: string[];
  activeId: string | null;
}

/** The local server's own workspace registry, read the way the app reads it. */
async function listWorkspaces(desktopApp: App): Promise<WorkspaceListing> {
  const value = await evalIn(desktopApp, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { error: "local_server_unavailable" };
    const response = await fetch(String(info.baseUrl).replace(/\\/+$/, "") + "/workspaces", {
      headers: { authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") },
    });
    if (!response.ok) return { error: "workspaces_http_" + response.status };
    const body = await response.json();
    const items = Array.isArray(body?.items) ? body.items : [];
    return {
      ids: items.map((item) => String(item?.id ?? "")).filter(Boolean),
      activeId: typeof body?.activeId === "string" ? body.activeId : null,
    };
  })()`, { awaitPromise: true, timeoutMs: 20_000 });
  if (!isRecord(value) || !Array.isArray(value.ids)) {
    throw new Error(`Listing workspaces failed: ${JSON.stringify(value)}`);
  }
  return {
    ids: value.ids.filter((id): id is string => typeof id === "string"),
    activeId: typeof value.activeId === "string" ? value.activeId : null,
  };
}

/** Create one workspace through the product's own control action and return its id. */
async function createWorkspace(desktopApp: App, label: string, index: number): Promise<string> {
  const before = await listWorkspaces(desktopApp);
  const path = `/tmp/openwork-${label}-${Date.now()}-${index}`;
  await control(desktopApp, "workspace.create", { path }, { timeoutMs: 90_000 });
  const after = await eventually(() => listWorkspaces(desktopApp), {
    within: 90_000,
    intervalMs: 500,
    label: `workspace ${label}-${index} registered`,
    until: (listing) => listing.ids.length === before.ids.length + 1,
  });
  const created = after.ids.find((candidate) => !before.ids.includes(candidate));
  if (!created) throw new Error(`workspace.create produced no new workspace id (before=${before.ids.length}, after=${after.ids.length}).`);
  return created;
}

/** Switch the UI to a workspace's session surface the way route navigation does. */
async function switchToWorkspace(desktopApp: App, workspaceId: string, dwellMs: number): Promise<void> {
  await go(desktopApp, `/workspace/${workspaceId}/session`);
  if (dwellMs > 0) await sleep(dwellMs);
}

/** Ask the real Den auth provider to re-read its session; exercises injected identity failures. */
async function refreshDenSession(desktopApp: App, times: number): Promise<void> {
  await evalIn(desktopApp, `(async () => {
    for (let index = 0; index < ${times}; index += 1) {
      window.dispatchEvent(new Event("openwork-den-session-updated"));
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
  })()`, { awaitPromise: true, timeoutMs: 10_000 });
}

async function probeDenPath(desktopApp: App, apiUrl: string, path: string, times: number): Promise<void> {
  await evalIn(desktopApp, `(async () => {
    const token = localStorage.getItem("openwork.den.authToken") ?? "";
    for (let index = 0; index < ${times}; index += 1) {
      try {
        await fetch(${JSON.stringify(apiUrl)} + ${JSON.stringify(path)}, {
          headers: { Authorization: "Bearer " + token },
        });
      } catch {}
    }
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
}

/** Wait until the app itself has adopted the workspace as active. */
async function waitForAdoptedWorkspace(desktopApp: App, workspaceId: string): Promise<void> {
  await waitFor(desktopApp, `(localStorage.getItem("openwork.react.activeWorkspace") ?? "") === ${JSON.stringify(workspaceId)}
    && window.location.hash.includes(${JSON.stringify(`/workspace/${workspaceId}`)})`, {
    timeoutMs: 60_000,
    label: `workspace ${workspaceId} adopted as active`,
  });
}

function unauthorizedDenResponses(log: FaultRequest[], fromIndex: number): FaultRequest[] {
  return log
    .slice(fromIndex)
    .filter((request) => !request.faulted && (request.status === 401 || request.status === 403));
}

function formatRequests(requests: FaultRequest[]): string {
  return JSON.stringify(requests.map((request) => `${request.method} ${request.path} -> ${request.status}`));
}

async function healthyBaseline(desktopApp: App): Promise<{ den: DenClientState; orgId: string }> {
  const den = await eventually(() => readDenClientState(desktopApp), {
    within: 60_000,
    label: "signed-in Den client state",
    until: (state) => state.authTokenPresent && Boolean(state.activeOrgId),
  });
  await eventually(() => readConnectState(desktopApp), {
    within: 120_000,
    label: "Connect available before the storm",
    until: (state) => state.ok && state.connectEnabled === true,
  });
  const orgId = den.activeOrgId;
  if (!orgId) throw new Error("The baseline Den client state has no active organization.");
  return { den, orgId };
}

interface StormOutcome {
  switches: number;
  authDropSamples: string[];
  orgChangeSamples: string[];
}

/**
 * Drive the switching storm: visit every workspace in the given order for the
 * given number of passes, sampling the Den client state as a person's session
 * would observe it mid-storm. Sampling never waits for the app to settle —
 * quick switching is the reported trigger.
 */
async function runSwitchStorm(
  desktopApp: App,
  workspaceIds: string[],
  input: { passes: number; dwellMs: number; sampleEvery: number; expectedOrgId: string },
): Promise<StormOutcome> {
  const outcome: StormOutcome = { switches: 0, authDropSamples: [], orgChangeSamples: [] };
  for (let pass = 0; pass < input.passes; pass += 1) {
    // Alternate direction so consecutive passes revisit the most recently
    // abandoned workspace first — the tightest A→B→A shape the report names.
    const order = pass % 2 === 0 ? workspaceIds : [...workspaceIds].reverse();
    for (const workspaceId of order) {
      await switchToWorkspace(desktopApp, workspaceId, input.dwellMs);
      outcome.switches += 1;
      if (outcome.switches % input.sampleEvery !== 0) continue;
      const state = await readDenClientState(desktopApp);
      if (!state.authTokenPresent) {
        outcome.authDropSamples.push(`switch ${outcome.switches} (workspace ${workspaceId}): auth token missing`);
      }
      if (state.activeOrgId !== input.expectedOrgId) {
        outcome.orgChangeSamples.push(`switch ${outcome.switches} (workspace ${workspaceId}): activeOrgId=${String(state.activeOrgId)}`);
      }
    }
  }
  return outcome;
}

async function assertPostStormCoherence(input: {
  desktopApp: App;
  proxy: FaultProxy;
  stormStartIndex: number;
  expectedOrgId: string;
  expectedWorkspaceIds: string[];
  finalWorkspaceId: string;
  evidence: { recordAssertionEvidence(claim: string, witness: string, passed: boolean): void };
  attempt: string;
}): Promise<void> {
  const { desktopApp, proxy, evidence, attempt } = input;

  await waitForAdoptedWorkspace(desktopApp, input.finalWorkspaceId);

  const finalDen = await readDenClientState(desktopApp);
  const authCoherent = finalDen.authTokenPresent && finalDen.activeOrgId === input.expectedOrgId;
  evidence.recordAssertionEvidence(
    `${attempt}: the Den session survives the storm`,
    `Final Den client state: authTokenPresent=${finalDen.authTokenPresent}, activeOrgId=${String(finalDen.activeOrgId)} (expected ${input.expectedOrgId}).`,
    authCoherent,
  );
  expect(finalDen.authTokenPresent).toBe(true);
  expect(finalDen.activeOrgId).toBe(input.expectedOrgId);

  const finalConnect = await eventually(() => readConnectState(desktopApp), {
    within: 120_000,
    label: `${attempt}: Connect state after the storm`,
    until: (state) => state.ok && state.status === "available" && state.connectEnabled === true,
  });
  evidence.recordAssertionEvidence(
    `${attempt}: Connect stays (or recovers to) available without a reconnect`,
    `Connect after the storm: ok=${finalConnect.ok}, status=${String(finalConnect.status)}, connectEnabled=${String(finalConnect.connectEnabled)}.`,
    finalConnect.ok && finalConnect.status === "available" && finalConnect.connectEnabled === true,
  );

  const listing = await eventually(() => listWorkspaces(desktopApp), {
    within: 60_000,
    intervalMs: 500,
    label: `${attempt}: local server adopts the final workspace`,
    until: (state) => state.activeId === input.finalWorkspaceId,
  });
  evidence.recordAssertionEvidence(
    `${attempt}: server activation is last-route-wins`,
    `The local server activeId is ${String(listing.activeId)} (expected ${input.finalWorkspaceId}).`,
    listing.activeId === input.finalWorkspaceId,
  );
  expect(listing.activeId).toBe(input.finalWorkspaceId);
  const missing = input.expectedWorkspaceIds.filter((id) => !listing.ids.includes(id));
  evidence.recordAssertionEvidence(
    `${attempt}: no workspace is lost by the storm`,
    `The local server lists ${listing.ids.length} workspaces; missing after the storm: ${JSON.stringify(missing)}.`,
    missing.length === 0,
  );
  expect(missing).toEqual([]);

  const log = await proxy.requestLog();
  const unauthorized = unauthorizedDenResponses(log, input.stormStartIndex);
  evidence.recordAssertionEvidence(
    `${attempt}: Den never answered the storm with a real authorization failure`,
    unauthorized.length === 0
      ? `The wire log recorded ${log.length - input.stormStartIndex} requests during the storm with zero non-injected 401/403 responses.`
      : `Non-injected unauthorized responses during the storm: ${formatRequests(unauthorized)}.`,
    unauthorized.length === 0,
  );
  expect(unauthorized, formatRequests(unauthorized)).toEqual([]);

  const shot = await screenshot(desktopApp);
  const seen = await validate(shot, [
    "The desktop shows a workspace session surface, not a sign-in or reconnect screen",
    "No error banner asks the user to reconnect or re-authenticate",
  ]);
  evidence.recordAssertionEvidence(
    `${attempt}: no reconnect or sign-in prompt is visible after the storm`,
    seen.ok ? "The post-storm screenshot shows a normal session surface." : `Visual validation failed: ${seen.why}`,
    seen.ok,
  );
  expect(seen.ok, seen.why).toBe(true);
}

// ---------------------------------------------------------------------------
// Attempt 1 — considerable scale: ~8 workspaces, round-robin switching storm.
// ---------------------------------------------------------------------------
test.skipIf(!runnable)(
  `${STORM_WORKSPACE_TOTAL} workspaces with rapid round-robin switching keep one coherent Cloud session${skipSuffix}`,
  { timeout: 30 * 60_000 },
  async ({ evidence, place }) => {
    needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
    await using den = await server({
      place,
      org: {
        name: "Workspace Storm Scale",
        admin: { name: "Storm Admin" },
        members: { member: { name: "Storm Member" } },
      },
    });
    await using proxy = await faultProxy(den.ref, {
      place,
      sandbox: den.placement?.kind === "daytona" ? den.placement.sandboxId : undefined,
    });
    await using desktopApp = await app({ den: { ...den, ref: proxy.ref }, as: "member", place });

    const baseline = await healthyBaseline(desktopApp);
    const workspaceIds = [desktopApp.workspaceId];
    for (let index = workspaceIds.length; index < STORM_WORKSPACE_TOTAL; index += 1) {
      workspaceIds.push(await createWorkspace(desktopApp, "storm-scale", index));
    }
    evidence.recordAssertionEvidence(
      "Attempt 1: the member reached the reported scale through the product itself",
      `${workspaceIds.length} workspaces exist, all created via the app's own workspace.create action.`,
      workspaceIds.length === STORM_WORKSPACE_TOTAL,
    );

    const stormStartIndex = (await proxy.requestLog()).length;
    const outcome = await runSwitchStorm(desktopApp, workspaceIds, {
      passes: 2,
      dwellMs: 400,
      sampleEvery: 5,
      expectedOrgId: baseline.orgId,
    });
    evidence.recordAssertionEvidence(
      "Attempt 1: mid-storm samples never observed a dropped session",
      `${outcome.switches} switches across ${workspaceIds.length} workspaces; auth drops: ${JSON.stringify(outcome.authDropSamples)}; org changes: ${JSON.stringify(outcome.orgChangeSamples)}.`,
      outcome.authDropSamples.length === 0 && outcome.orgChangeSamples.length === 0,
    );
    expect(outcome.authDropSamples).toEqual([]);
    expect(outcome.orgChangeSamples).toEqual([]);

    const finalWorkspaceId = workspaceIds[0];
    await switchToWorkspace(desktopApp, finalWorkspaceId, 0);
    await assertPostStormCoherence({
      desktopApp,
      proxy,
      stormStartIndex,
      expectedOrgId: baseline.orgId,
      expectedWorkspaceIds: workspaceIds,
      finalWorkspaceId,
      evidence,
      attempt: "Attempt 1",
    });

    // The reported symptom is Cloud tools claiming to need a reconnect while
    // connected: the settled workspace's openwork-cloud MCP must still be
    // usable with its capability tools present.
    const health = await eventually(
      () => readCloudMcpHealth(desktopApp, finalWorkspaceId, { probe: true, timeoutMs: 30_000 }),
      {
        within: 180_000,
        intervalMs: 5_000,
        label: "openwork-cloud MCP usable after the scale storm",
        until: (state) => state.ok && state.usable === true,
      },
    );
    evidence.recordAssertionEvidence(
      "Attempt 1: the Cloud MCP stays usable after the storm instead of demanding a reconnect",
      `Health for workspace ${finalWorkspaceId}: phase=${String(health.phase)}, usable=${String(health.usable)}, engine=${String(health.engineStatus)}, missing tools=${JSON.stringify(health.tools.missing)}.`,
      health.ok && health.usable === true,
    );
    expect(health.usable).toBe(true);
  },
);

// ---------------------------------------------------------------------------
// Attempt 2 — Marten-scale: 6 workspaces, switching while Den is overloaded
// (latency + 429 bursts) and while Den briefly answers 401 on identity reads.
// ---------------------------------------------------------------------------
test.skipIf(!runnable)(
  `six workspaces switched under Den overload and a transient 401 burst recover without a reconnect${skipSuffix}`,
  { timeout: 25 * 60_000 },
  async ({ evidence, place }) => {
    needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
    await using den = await server({
      place,
      org: {
        name: "Workspace Storm Overload",
        admin: { name: "Overload Admin" },
        members: { member: { name: "Overload Member" } },
      },
    });
    await using proxy = await faultProxy(den.ref, {
      place,
      sandbox: den.placement?.kind === "daytona" ? den.placement.sandboxId : undefined,
    });
    await using desktopApp = await app({ den: { ...den, ref: proxy.ref }, as: "member", place });

    const baseline = await healthyBaseline(desktopApp);
    const workspaceIds = [desktopApp.workspaceId];
    for (let index = workspaceIds.length; index < 6; index += 1) {
      workspaceIds.push(await createWorkspace(desktopApp, "storm-overload", index));
    }

    const stormStartIndex = (await proxy.requestLog()).length;

    // Wave A — the reported "unusually high demand": every Den response is
    // slow for a while and desktop-config intermittently rate-limits.
    await proxy.faults.latency("/api/den", 1_200, { times: 40 });
    await proxy.faults.status("/api/den/v1/me/desktop-config", 429, { times: 6 });
    await probeDenPath(desktopApp, proxy.ref.apiUrl, "/v1/me/desktop-config", 1);
    const waveA = await runSwitchStorm(desktopApp, workspaceIds, {
      passes: 2,
      dwellMs: 500,
      sampleEvery: 3,
      expectedOrgId: baseline.orgId,
    });
    evidence.recordAssertionEvidence(
      "Attempt 2, wave A: overload (latency + 429) never dropped the session mid-storm",
      `${waveA.switches} switches under injected latency/429; auth drops: ${JSON.stringify(waveA.authDropSamples)}; org changes: ${JSON.stringify(waveA.orgChangeSamples)}.`,
      waveA.authDropSamples.length === 0 && waveA.orgChangeSamples.length === 0,
    );
    expect(waveA.authDropSamples).toEqual([]);
    expect(waveA.orgChangeSamples).toEqual([]);

    // Wave B — Den itself briefly answers identity reads with 401, the shape
    // members reported as "failed authorization" while still connected. A
    // bounded burst must not sign the desktop out or flip Connect off for good.
    await proxy.faults.clear();
    await proxy.faults.status("/api/den", 401, { times: 6 });
    await probeDenPath(desktopApp, proxy.ref.apiUrl, "/v1/me/orgs", 6);
    await refreshDenSession(desktopApp, 6);
    const waveB = await runSwitchStorm(desktopApp, workspaceIds, {
      passes: 2,
      dwellMs: 500,
      sampleEvery: 3,
      expectedOrgId: baseline.orgId,
    });
    evidence.recordAssertionEvidence(
      "Attempt 2, wave B: a transient 401 burst never removed the persisted session",
      `${waveB.switches} switches during the 401 burst; auth drops: ${JSON.stringify(waveB.authDropSamples)}; org changes: ${JSON.stringify(waveB.orgChangeSamples)}.`,
      waveB.authDropSamples.length === 0 && waveB.orgChangeSamples.length === 0,
    );
    expect(waveB.authDropSamples).toEqual([]);
    expect(waveB.orgChangeSamples).toEqual([]);

    // The injected faults were actually exercised — otherwise this attempt
    // proved nothing about overload behavior.
    const log = await proxy.requestLog();
    const injected = log.slice(stormStartIndex).filter((request) => request.faulted);
    const injected401 = injected.filter((request) => request.status === 401);
    evidence.recordAssertionEvidence(
      "Attempt 2: the overload and 401 conditions were real on the wire",
      `Injected fault responses during the storm: ${injected.length} total, ${injected401.length} with status 401.`,
      injected.length > 0 && injected401.length > 0,
    );
    expect(injected.length).toBeGreaterThan(0);
    expect(injected401.length).toBeGreaterThan(0);

    await proxy.faults.clear();
    const finalWorkspaceId = workspaceIds[workspaceIds.length - 1];
    await switchToWorkspace(desktopApp, finalWorkspaceId, 0);
    await assertPostStormCoherence({
      desktopApp,
      proxy,
      stormStartIndex,
      expectedOrgId: baseline.orgId,
      expectedWorkspaceIds: workspaceIds,
      finalWorkspaceId,
      evidence,
      attempt: "Attempt 2",
    });
  },
);

// ---------------------------------------------------------------------------
// Attempt 3 — the tightest race: two workspaces toggled with zero dwell time.
// ---------------------------------------------------------------------------
test.skipIf(!runnable)(
  `forty zero-dwell toggles between two workspaces settle on one coherent active workspace${skipSuffix}`,
  { timeout: 20 * 60_000 },
  async ({ evidence, place }) => {
    needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
    await using den = await server({
      place,
      org: {
        name: "Workspace Storm Race",
        admin: { name: "Race Admin" },
        members: { member: { name: "Race Member" } },
      },
    });
    await using proxy = await faultProxy(den.ref, {
      place,
      sandbox: den.placement?.kind === "daytona" ? den.placement.sandboxId : undefined,
    });
    await using desktopApp = await app({ den: { ...den, ref: proxy.ref }, as: "member", place });

    const baseline = await healthyBaseline(desktopApp);
    const first = desktopApp.workspaceId;
    const second = await createWorkspace(desktopApp, "storm-race", 1);

    const stormStartIndex = (await proxy.requestLog()).length;
    const toggles = 40;
    for (let index = 0; index < toggles; index += 1) {
      await switchToWorkspace(desktopApp, index % 2 === 0 ? first : second, 0);
    }
    const finalWorkspaceId = toggles % 2 === 0 ? second : first;
    evidence.recordAssertionEvidence(
      "Attempt 3: the race condition was actually driven",
      `${toggles} zero-dwell toggles between workspaces ${first} and ${second}; the last requested workspace is ${finalWorkspaceId}.`,
      true,
    );

    const gateInstalled = await evalIn(desktopApp, `(() => {
      const originalFetch = window.fetch.bind(window);
      let releaseGate = () => {};
      const gate = new Promise((resolve) => { releaseGate = resolve; });
      const state = {
        entered: false,
        released: false,
        firstCompleted: false,
        errors: [],
        release: () => {
          if (state.released) return;
          state.released = true;
          window.fetch = originalFetch;
          releaseGate();
        },
      };
      window.__workspaceStormSettingsGate = state;
      window.addEventListener("error", (event) => state.errors.push(String(event.error?.message ?? event.message ?? "window error")));
      window.addEventListener("unhandledrejection", (event) => state.errors.push(String(event.reason?.message ?? event.reason ?? "unhandled rejection")));
      window.fetch = async (input, init) => {
        const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        let pathname = "";
        try { pathname = new URL(rawUrl, window.location.href).pathname; } catch {}
        if (!state.entered && method === "GET" && pathname === "/workspaces") {
          state.entered = true;
          await gate;
          const response = await originalFetch(input, init);
          state.firstCompleted = true;
          return response;
        }
        return originalFetch(input, init);
      };
      return true;
    })()`);
    expect(gateInstalled).toBe(true);
    await go(desktopApp, `/workspace/${encodeURIComponent(first)}/settings/general`);
    await waitFor(desktopApp, "window.__workspaceStormSettingsGate?.entered === true", {
      timeoutMs: 30_000,
      label: "first Settings workspace refresh held in flight",
    });
    await go(desktopApp, `/workspace/${encodeURIComponent(finalWorkspaceId)}/settings/general`);
    await waitFor(desktopApp, `window.location.hash.includes(${JSON.stringify(`/workspace/${encodeURIComponent(finalWorkspaceId)}/settings/general`)})
      && document.body.innerText.includes("Overview of all settings")`, {
      timeoutMs: 90_000,
      label: "final Settings route rendered while the stale refresh is held",
    });
    const coherentBeforeRelease = await eventually(
      () => evalIn(desktopApp, `(async () => {
        const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
        const desktopState = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("workspaceBootstrap");
        const response = await fetch(String(info?.baseUrl ?? "").replace(/\\/+$/, "") + "/workspaces", {
          headers: { authorization: "Bearer " + String(info?.ownerToken ?? info?.clientToken ?? "") },
        });
        const body = await response.json();
        return {
          stored: localStorage.getItem("openwork.react.activeWorkspace") ?? "",
          selected: String(desktopState?.selectedId ?? ""),
          watched: String(desktopState?.watchedId ?? ""),
          desktop: String(desktopState?.activeId ?? ""),
          server: String(body?.activeId ?? ""),
        };
      })()`, { awaitPromise: true, timeoutMs: 20_000 }),
      {
        within: 90_000,
        intervalMs: 500,
        label: "final Settings runtime coherent before stale response release",
        until: (value) => isRecord(value) && Object.values(value).every((id) => id === finalWorkspaceId),
      },
    );
    if (!isRecord(coherentBeforeRelease)) throw new Error(`Settings coherence probe was malformed: ${JSON.stringify(coherentBeforeRelease)}`);
    expect(Object.values(coherentBeforeRelease)).toEqual(Array(5).fill(finalWorkspaceId));
    evidence.recordAssertionEvidence(
      "Attempt 3: Settings adopts one coherent runtime before a stale workspace response resolves",
      `Active workspace records before release: ${JSON.stringify(coherentBeforeRelease)}.`,
      true,
    );

    await evalIn(desktopApp, "window.__workspaceStormSettingsGate?.release(); true");
    await waitFor(desktopApp, "window.__workspaceStormSettingsGate?.firstCompleted === true", {
      timeoutMs: 30_000,
      label: "held workspace response completed",
    });
    await sleep(2_000);
    const afterRelease = await evalIn(desktopApp, `(() => ({
      active: localStorage.getItem("openwork.react.activeWorkspace") ?? "",
      errors: [...(window.__workspaceStormSettingsGate?.errors ?? [])],
      visibleError: /Failed to fetch|OpenCode base URL is missing|Workspace configuration failed|Runtime error/.test(document.body.innerText),
    }))()`);
    expect(afterRelease).toMatchObject({ active: finalWorkspaceId, errors: [], visibleError: false });
    await switchToWorkspace(desktopApp, finalWorkspaceId, 0);

    // The lost-update shape: after the burst the app must converge on the
    // LAST requested workspace, not an intermediate one.
    await assertPostStormCoherence({
      desktopApp,
      proxy,
      stormStartIndex,
      expectedOrgId: baseline.orgId,
      expectedWorkspaceIds: [first, second],
      finalWorkspaceId,
      evidence,
      attempt: "Attempt 3",
    });

    const adopted = await evalIn(desktopApp, `localStorage.getItem("openwork.react.activeWorkspace") ?? ""`);
    evidence.recordAssertionEvidence(
      "Attempt 3: no lost update — the adopted workspace is the last one requested",
      `openwork.react.activeWorkspace=${JSON.stringify(adopted)} after ${toggles} toggles (expected ${finalWorkspaceId}).`,
      adopted === finalWorkspaceId,
    );
    expect(adopted).toBe(finalWorkspaceId);
  },
);
