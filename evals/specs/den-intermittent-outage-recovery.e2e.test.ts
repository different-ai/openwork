import { expect } from "vitest";
import { evalIn, go, waitFor } from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/test-evidence";
import {
  app,
  eventually,
  faultProxy,
  localMysqlIsRunning,
  needs,
  readConnectState,
  readDenClientState,
  server,
  test,
} from "@openwork/testkit";
import type { App, DesktopHandle, FaultProxy } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const daytonaEnabled = process.env.OPENWORK_EVAL_DAYTONA === "1";
const configuredDen = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const localMysqlRequired = !daytonaEnabled && !configuredDen;
const mysqlOpen = await localMysqlIsRunning();
const runnable = e2eTestsEnabled && (!localMysqlRequired || mysqlOpen);
const title = !e2eTestsEnabled
  ? "desktop intermittent Den connection loss skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1"
  : localMysqlRequired && !mysqlOpen
    ? "desktop intermittent Den connection loss skipped — needs MySQL on 127.0.0.1:3306"
    : "desktop survives intermittent Den connection loss: engine stays up, health stays honest, Connect recovers";

interface EngineIdentity {
  pid: number | null;
  baseUrl: string;
  lifecycleState: string;
}

interface SidebarState {
  runtimeState: string;
  connectState: string;
}

interface DiagnosticsState {
  reportText: string;
  overallText: string;
  overallFailed: boolean;
  firstFailure: string;
  running: boolean;
  errorText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readEngineIdentity(desktopApp: DesktopHandle): Promise<EngineIdentity> {
  const value = await evalIn(desktopApp, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("engineInfo");
    return {
      pid: typeof info?.pid === "number" ? info.pid : null,
      baseUrl: typeof info?.baseUrl === "string" ? info.baseUrl : "",
      lifecycleState: typeof info?.lifecycleState === "string" ? info.lifecycleState : "",
    };
  })()`, { awaitPromise: true, timeoutMs: 15_000 });
  if (!isRecord(value)) throw new Error("engineInfo returned no identity snapshot");
  return {
    pid: typeof value.pid === "number" ? value.pid : null,
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
    lifecycleState: typeof value.lifecycleState === "string" ? value.lifecycleState : "",
  };
}

function sameEngine(actual: EngineIdentity, baseline: EngineIdentity): boolean {
  return actual.pid === baseline.pid
    && actual.baseUrl === baseline.baseUrl
    && actual.lifecycleState === "healthy";
}

async function waitForEngine(
  desktopApp: DesktopHandle,
  label: string,
  baseline?: EngineIdentity,
): Promise<EngineIdentity> {
  return eventually(() => readEngineIdentity(desktopApp), {
    within: 120_000,
    intervalMs: 1_000,
    label,
    until: (identity) => identity.baseUrl.length > 0
      && identity.lifecycleState === "healthy"
      && (baseline === undefined || sameEngine(identity, baseline)),
  });
}

async function readSidebarState(desktopApp: DesktopHandle): Promise<SidebarState> {
  const value = await evalIn(desktopApp, `(() => {
    const menu = document.querySelector('[data-testid="account-status-menu"]');
    return {
      runtimeState: menu?.getAttribute("data-runtime-state") ?? "",
      connectState: menu?.getAttribute("data-connect-state") ?? "",
    };
  })()`);
  if (!isRecord(value)) throw new Error("account status menu returned no state");
  return {
    runtimeState: typeof value.runtimeState === "string" ? value.runtimeState : "",
    connectState: typeof value.connectState === "string" ? value.connectState : "",
  };
}

async function dispatchRetryEvents(desktopApp: DesktopHandle): Promise<void> {
  const dispatched = await evalIn(
    desktopApp,
    `window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus")); true`,
  );
  expect(dispatched).toBe(true);
}

async function readDiagnosticsState(desktopApp: DesktopHandle): Promise<DiagnosticsState> {
  const value = await evalIn(desktopApp, `(() => {
    const report = document.querySelector('[data-testid="agent-diagnostics-report"]');
    const overall = document.querySelector('[data-testid="agent-diagnostics-overall"]');
    const firstFailure = document.querySelector('[data-testid="agent-diagnostics-first-failure"]');
    const run = document.querySelector('[data-testid="run-agent-diagnostics"]');
    const error = document.querySelector('[data-testid="agent-diagnostics-error"]');
    return {
      reportText: report?.textContent ?? "",
      overallText: overall?.textContent?.trim() ?? "",
      overallFailed: Boolean(overall?.querySelector(".text-red-11")),
      firstFailure: firstFailure?.textContent?.trim() ?? "",
      running: run instanceof HTMLButtonElement && run.disabled,
      errorText: error?.textContent?.trim() ?? "",
    };
  })()`);
  if (!isRecord(value)) throw new Error("agent diagnostics returned no report state");
  return {
    reportText: typeof value.reportText === "string" ? value.reportText : "",
    overallText: typeof value.overallText === "string" ? value.overallText : "",
    overallFailed: value.overallFailed === true,
    firstFailure: typeof value.firstFailure === "string" ? value.firstFailure : "",
    running: value.running === true,
    errorText: typeof value.errorText === "string" ? value.errorText : "",
  };
}

async function runDiagnostics(desktopApp: DesktopHandle, label: string): Promise<DiagnosticsState> {
  const before = await readDiagnosticsState(desktopApp);
  // During the 503 storm a diagnostics run can occasionally fail outright and
  // render the error notice instead of a report; the claim is about a
  // completed live run, not first-click luck, so one bounded retry is allowed.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await waitFor(
      desktopApp,
      `(() => {
        const run = document.querySelector('[data-testid="run-agent-diagnostics"]');
        return run instanceof HTMLButtonElement && !run.disabled;
      })()`,
      { timeoutMs: 120_000, label: `${label} run control (attempt ${attempt})` },
    );
    const clicked = await evalIn(desktopApp, `(() => {
      const run = document.querySelector('[data-testid="run-agent-diagnostics"]');
      if (!(run instanceof HTMLButtonElement) || run.disabled) return false;
      run.click();
      return true;
    })()`);
    expect(clicked).toBe(true);
    try {
      return await eventually(() => readDiagnosticsState(desktopApp), {
        within: 120_000,
        intervalMs: 1_000,
        label: `${label} completed report (attempt ${attempt})`,
        until: (state) => !state.running
          && state.reportText.length > 0
          && state.reportText !== before.reportText,
      });
    } catch (error) {
      const lastState = await readDiagnosticsState(desktopApp);
      console.log(
        `[den-outage-spec] ${label} attempt ${attempt} produced no report; error notice: ${JSON.stringify(lastState.errorText)}`,
      );
      if (attempt === 2) throw error;
    }
  }
  throw new Error(`${label} produced no diagnostics report.`);
}

async function openDiagnostics(desktopApp: App): Promise<void> {
  await go(desktopApp, `/workspace/${desktopApp.workspaceId}/settings/debug`);
  await waitFor(
    desktopApp,
    `Boolean(document.querySelector('[data-testid="run-agent-diagnostics"]'))`,
    { timeoutMs: 120_000, label: "agent context diagnostics debug route" },
  );
}

async function openSession(desktopApp: App): Promise<void> {
  await go(desktopApp, `/workspace/${desktopApp.workspaceId}/session`);
  await waitFor(
    desktopApp,
    `Boolean(document.querySelector('[data-testid="account-status-menu"]'))`,
    { timeoutMs: 120_000, label: "session account status menu" },
  );
}

async function revealDiagnosticsReport(desktopApp: DesktopHandle): Promise<void> {
  const found = await evalIn(desktopApp, `(() => {
    const overall = document.querySelector('[data-testid="agent-diagnostics-overall"]');
    overall?.scrollIntoView({ block: "start" });
    return Boolean(overall);
  })()`);
  expect(found).toBe(true);
  await waitFor(desktopApp, `(() => {
    const overall = document.querySelector('[data-testid="agent-diagnostics-overall"]');
    if (!overall) return false;
    const rect = overall.getBoundingClientRect();
    // Framed = the overall chip intersects the visible viewport at all; the
    // settings page scrolls an inner container behind a sticky header, so any
    // stricter offset predicate is unstable.
    return rect.bottom > 0 && rect.top < window.innerHeight;
  })()`, { timeoutMs: 15_000, label: "diagnostics report framed in viewport" });
}

async function waitForFaultedRequest(
  desktopApp: DesktopHandle,
  proxy: FaultProxy,
  since: number,
  label: string,
) {
  return eventually(
    async () => {
      await dispatchRetryEvents(desktopApp);
      return (await proxy.requestLog()).filter(
        (request) => request.faulted && request.status === 503 && request.at >= since,
      );
    },
    { within: 120_000, intervalMs: 5_000, label, until: (requests) => requests.length > 0 },
  );
}

async function waitForRecoveredRequest(
  desktopApp: DesktopHandle,
  proxy: FaultProxy,
  since: number,
  label: string,
) {
  return eventually(
    async () => {
      await dispatchRetryEvents(desktopApp);
      return (await proxy.requestLog()).filter(
        (request) => !request.faulted && request.status < 400 && request.at >= since,
      );
    },
    { within: 120_000, intervalMs: 5_000, label, until: (requests) => requests.length > 0 },
  );
}

test.skipIf(!runnable)(title, { timeout: 1_500_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  const stamp = Date.now();
  await using den = await server({
    place,
    org: {
      name: `Intermittent Outage ${stamp}`,
      admin: {
        email: `intermittent-outage-admin-${stamp}@openwork.test`,
        name: "Intermittent Outage Admin",
        password: "OpenWorkEval123!",
      },
    },
  });
  await using proxy = await faultProxy(den.ref, {
    place,
    sandbox: den.placement?.kind === "daytona" ? den.placement.sandboxId : undefined,
  });
  await using desktopApp = await app({ den: { ...den, ref: proxy.ref }, as: "admin", place });

  // Phase 0: establish a healthy signed-in baseline on the session route.
  console.log("[den-outage-spec] baseline start");
  const baselineDen = await eventually(() => readDenClientState(desktopApp), {
    within: 120_000,
    intervalMs: 1_000,
    label: "baseline Den authentication and organization",
    until: (state) => state.authTokenPresent && Boolean(state.activeOrgId),
  });
  expect(baselineDen.authTokenPresent).toBe(true);
  expect(baselineDen.activeOrgId).toBeTruthy();
  const orgId = baselineDen.activeOrgId;
  if (!orgId) throw new Error("The healthy baseline did not select an organization.");

  const baselineConnect = await eventually(() => readConnectState(desktopApp), {
    within: 120_000,
    intervalMs: 1_000,
    label: "baseline local Connect state",
    until: (state) => state.ok && state.connectEnabled === true,
  });
  expect(baselineConnect).toMatchObject({ ok: true, connectEnabled: true });
  const baselineEngine = await waitForEngine(desktopApp, "baseline healthy engine identity");
  const baselineSidebar = await eventually(() => readSidebarState(desktopApp), {
    within: 120_000,
    intervalMs: 1_000,
    label: "baseline sidebar health",
    until: (state) => state.runtimeState !== "" && state.connectState === "ready",
  });
  expect(baselineSidebar.runtimeState).not.toBe("disconnected");
  evidence.recordAssertionEvidence(
    "The signed-in desktop began healthy without coupling Connect to the local engine",
    `Organization ${orgId}; Connect ok=${baselineConnect.ok}, enabled=${baselineConnect.connectEnabled}; engine=${JSON.stringify(baselineEngine)}; sidebar=${JSON.stringify(baselineSidebar)}.`,
    baselineDen.authTokenPresent
      && baselineConnect.ok
      && baselineConnect.connectEnabled === true
      && baselineEngine.lifecycleState === "healthy"
      && baselineSidebar.runtimeState !== "disconnected",
  );
  const baselineHealthyShot = await screenshot(desktopApp);
  const baselineHealthySeen = await validate(baselineHealthyShot, [
    "The desktop session surface is visibly rendered",
    "No application crash or disconnected local runtime screen is visible",
  ]);
  expect(baselineHealthySeen.ok, baselineHealthySeen.why).toBe(true);

  await evalIn(desktopApp, `localStorage.setItem("openwork.developerMode", "1"); true`);
  await openDiagnostics(desktopApp);
  const baselineDiagnostics = await runDiagnostics(desktopApp, "healthy baseline diagnostics");
  expect(baselineDiagnostics.overallFailed, JSON.stringify(baselineDiagnostics)).toBe(false);
  evidence.recordAssertionEvidence(
    "baseline diagnostics report no failed check",
    `Baseline diagnostics overall=${JSON.stringify(baselineDiagnostics.overallText)}, first failure=${JSON.stringify(baselineDiagnostics.firstFailure)}.`,
    !baselineDiagnostics.overallFailed,
  );
  await openSession(desktopApp);
  console.log("[den-outage-spec] baseline done");

  const authSamples = [baselineDen];

  // Phase 1: every Den request receives a wire-level 503 while the local engine remains healthy.
  await proxy.faults.status("/", 503, { times: 100_000 });
  console.log("[den-outage-spec] outage A injected");
  const outageAStart = Date.now();
  await dispatchRetryEvents(desktopApp);
  const outageAWire = await waitForFaultedRequest(desktopApp, proxy, outageAStart, "outage A injected 503 request");
  expect(outageAWire.length).toBeGreaterThan(0);

  const outageAEngine = await waitForEngine(desktopApp, "outage A unchanged healthy engine", baselineEngine);
  expect(outageAEngine).toEqual(baselineEngine);
  const outageAConnectTransport = await eventually(() => readConnectState(desktopApp), {
    within: 120_000,
    intervalMs: 1_000,
    label: "outage A local Connect state transport",
    until: (state) => state.ok,
  });
  expect(outageAConnectTransport.ok).toBe(true);

  const outageADen = await eventually(() => readDenClientState(desktopApp), {
    within: 120_000,
    intervalMs: 1_000,
    label: "outage A retained authentication",
    until: (state) => state.authTokenPresent && state.activeOrgId === orgId,
  });
  authSamples.push(outageADen);
  expect(outageADen).toMatchObject({ authTokenPresent: true, activeOrgId: orgId });

  // Passive Connect status is cache-based (maintenance freshness margin + flap suppression); live diagnostics assert outage honesty.
  const outageASidebar = await eventually(() => readSidebarState(desktopApp), {
    within: 15_000,
    intervalMs: 1_000,
    label: "outage A unchanged sidebar runtime state",
    until: (state) => state.runtimeState.length > 0,
  });
  expect(outageASidebar.runtimeState).toBe(baselineSidebar.runtimeState);
  await openDiagnostics(desktopApp);
  // In eval topology the runtime endpoint probe is trust-gated (untrusted_endpoint), so outage truth surfaces as an organization-connections warning.
  const outageADiagnostics = await runDiagnostics(desktopApp, "outage A diagnostics");
  expect(
    outageADiagnostics.reportText.includes("List failed"),
    JSON.stringify(outageADiagnostics),
  ).toBe(true);
  expect(
    baselineDiagnostics.reportText.includes("List failed"),
    JSON.stringify(baselineDiagnostics),
  ).toBe(false);
  evidence.recordAssertionEvidence(
    "Outage A was exercised at the wire without restarting the engine or destroying authentication",
    `${outageAWire.length} faulted HTTP 503 request(s); engine=${JSON.stringify(outageAEngine)}; local Connect transport ok=${outageAConnectTransport.ok}; token retained for ${outageADen.activeOrgId}.`,
    outageAWire.length > 0
      && sameEngine(outageAEngine, baselineEngine)
      && outageAConnectTransport.ok
      && outageADen.authTokenPresent
      && outageADen.activeOrgId === orgId,
  );
  evidence.recordAssertionEvidence(
    "Outage A health surfaces stayed honest while the local runtime stayed available",
    `The passive sidebar Connect chip remained ${JSON.stringify(outageASidebar.connectState)} during the outage while live diagnostics recorded List failed=true and Cloud unavailable=${outageADiagnostics.reportText.includes("Cloud unavailable")}; overall=${JSON.stringify(outageADiagnostics.overallText)}, first failure=${JSON.stringify(outageADiagnostics.firstFailure)}; runtime stayed ${JSON.stringify(outageASidebar.runtimeState)}.`,
    outageASidebar.runtimeState === baselineSidebar.runtimeState
      && outageADiagnostics.reportText.includes("List failed")
      && !baselineDiagnostics.reportText.includes("List failed"),
  );
  await revealDiagnosticsReport(desktopApp);
  const outageAShot = await screenshot(desktopApp);
  const outageASeen = await validate(outageAShot, [
    "The diagnostics report remains visibly rendered during the connection outage",
    // The organization-connections observation itself is proven by the DOM
    // assertion on reportText; one frame cannot show both the overall chip and
    // that row, so the claimed frame carries only the overall status.
    "The report visibly shows a Warning overall status",
    "No application crash or disconnected local runtime screen is visible",
  ]);
  expect(outageASeen.ok, outageASeen.why).toBe(true);
  await openSession(desktopApp);
  console.log("[den-outage-spec] outage A verified");

  // Phase 2: clearing the wire fault heals Connect without a restart or sign-in flow.
  await proxy.faults.clear();
  console.log("[den-outage-spec] recovery A cleared");
  const recoveryAStart = Date.now();
  await dispatchRetryEvents(desktopApp);
  const recoveryAConnect = await eventually(async () => {
    await dispatchRetryEvents(desktopApp);
    return readConnectState(desktopApp);
  }, {
    within: 120_000,
    intervalMs: 5_000,
    label: "recovery A local Connect state",
    until: (state) => state.ok && state.connectEnabled === true,
  });
  expect(recoveryAConnect).toMatchObject({ ok: true, connectEnabled: true });
  const recoveryADen = await eventually(() => readDenClientState(desktopApp), {
    within: 120_000,
    intervalMs: 1_000,
    label: "recovery A retained authentication",
    until: (state) => state.authTokenPresent && state.activeOrgId === orgId,
  });
  authSamples.push(recoveryADen);
  const recoveryASidebar = await eventually(async () => {
    await dispatchRetryEvents(desktopApp);
    return readSidebarState(desktopApp);
  }, {
    within: 120_000,
    intervalMs: 5_000,
    label: "recovery A sidebar ready",
    until: (state) => state.connectState === "ready" && state.runtimeState !== "disconnected",
  });
  expect(recoveryASidebar.connectState).toBe("ready");
  const recoveryAWire = await waitForRecoveredRequest(desktopApp, proxy, recoveryAStart, "recovery A successful Den request");
  await openDiagnostics(desktopApp);
  const recoveryADiagnostics = await runDiagnostics(desktopApp, "recovery A diagnostics");
  const recoveryADiagnosticsMatchesBaseline = !recoveryADiagnostics.overallFailed
    && recoveryADiagnostics.overallText === baselineDiagnostics.overallText
    && !recoveryADiagnostics.reportText.includes("List failed")
    && recoveryADiagnostics.firstFailure === baselineDiagnostics.firstFailure;
  expect(recoveryADiagnostics.overallFailed, JSON.stringify(recoveryADiagnostics)).toBe(false);
  expect(recoveryADiagnostics.overallText, JSON.stringify(recoveryADiagnostics)).toBe(baselineDiagnostics.overallText);
  expect(recoveryADiagnostics.reportText.includes("List failed"), JSON.stringify(recoveryADiagnostics)).toBe(false);
  expect(recoveryADiagnostics.firstFailure, JSON.stringify(recoveryADiagnostics)).toBe(baselineDiagnostics.firstFailure);
  evidence.recordAssertionEvidence(
    "Connect recovered automatically after outage A without re-authentication",
    `${recoveryAWire.length} successful post-clear request(s); Connect=${JSON.stringify(recoveryAConnect)}; sidebar=${JSON.stringify(recoveryASidebar)}; diagnostics List failed=false and overall returned to baseline ${JSON.stringify(baselineDiagnostics.overallText)}; organization=${recoveryADen.activeOrgId}.`,
    recoveryAWire.length > 0
      && recoveryAConnect.ok
      && recoveryAConnect.connectEnabled === true
      && recoveryASidebar.connectState === "ready"
      && recoveryADiagnosticsMatchesBaseline
      && recoveryADen.authTokenPresent
      && recoveryADen.activeOrgId === orgId,
  );
  // Unclaimed take; vision budget lives on the three decisive frames.
  await screenshot(desktopApp);
  await openSession(desktopApp);
  console.log("[den-outage-spec] recovery A verified");

  // Phase 3: a second complete outage and recovery proves the behavior is intermittent, not one-shot.
  await proxy.faults.status("/", 503, { times: 100_000 });
  console.log("[den-outage-spec] outage B injected");
  const outageBStart = Date.now();
  await dispatchRetryEvents(desktopApp);
  const outageBWire = await waitForFaultedRequest(desktopApp, proxy, outageBStart, "outage B injected 503 request");
  const outageBEngine = await waitForEngine(desktopApp, "outage B unchanged healthy engine", baselineEngine);
  expect(outageBEngine).toEqual(baselineEngine);
  const outageBDen = await eventually(() => readDenClientState(desktopApp), {
    within: 120_000,
    intervalMs: 1_000,
    label: "outage B retained authentication",
    until: (state) => state.authTokenPresent && state.activeOrgId === orgId,
  });
  authSamples.push(outageBDen);
  expect(outageBDen).toMatchObject({ authTokenPresent: true, activeOrgId: orgId });
  evidence.recordAssertionEvidence(
    "Outage B repeated the wire fault without restarting the engine or destroying authentication",
    `${outageBWire.length} faulted HTTP 503 request(s); engine=${JSON.stringify(outageBEngine)}; token retained for ${outageBDen.activeOrgId}.`,
    outageBWire.length > 0
      && sameEngine(outageBEngine, baselineEngine)
      && outageBDen.authTokenPresent
      && outageBDen.activeOrgId === orgId,
  );
  await openDiagnostics(desktopApp);
  // Unclaimed take; vision budget lives on the three decisive frames.
  await screenshot(desktopApp);
  await openSession(desktopApp);
  console.log("[den-outage-spec] outage B verified");

  await proxy.faults.clear();
  console.log("[den-outage-spec] recovery B cleared");
  const recoveryBStart = Date.now();
  await dispatchRetryEvents(desktopApp);
  const recoveryBConnect = await eventually(async () => {
    await dispatchRetryEvents(desktopApp);
    return readConnectState(desktopApp);
  }, {
    within: 120_000,
    intervalMs: 5_000,
    label: "recovery B local Connect state",
    until: (state) => state.ok && state.connectEnabled === true,
  });
  const recoveryBDen = await eventually(() => readDenClientState(desktopApp), {
    within: 120_000,
    intervalMs: 1_000,
    label: "recovery B retained authentication",
    until: (state) => state.authTokenPresent && state.activeOrgId === orgId,
  });
  authSamples.push(recoveryBDen);
  const recoveryBSidebar = await eventually(async () => {
    await dispatchRetryEvents(desktopApp);
    return readSidebarState(desktopApp);
  }, {
    within: 120_000,
    intervalMs: 5_000,
    label: "recovery B sidebar ready",
    until: (state) => state.connectState === "ready" && state.runtimeState !== "disconnected",
  });
  const recoveryBWire = await waitForRecoveredRequest(desktopApp, proxy, recoveryBStart, "recovery B successful Den request");
  await openDiagnostics(desktopApp);
  const recoveryBDiagnostics = await runDiagnostics(desktopApp, "recovery B diagnostics");
  expect(recoveryBConnect).toMatchObject({ ok: true, connectEnabled: true });
  expect(recoveryBDen).toMatchObject({ authTokenPresent: true, activeOrgId: orgId });
  expect(recoveryBSidebar.connectState).toBe("ready");
  const recoveryBDiagnosticsMatchesBaseline = !recoveryBDiagnostics.overallFailed
    && recoveryBDiagnostics.overallText === baselineDiagnostics.overallText
    && !recoveryBDiagnostics.reportText.includes("List failed")
    && recoveryBDiagnostics.firstFailure === baselineDiagnostics.firstFailure;
  expect(recoveryBDiagnostics.overallFailed, JSON.stringify(recoveryBDiagnostics)).toBe(false);
  expect(recoveryBDiagnostics.overallText, JSON.stringify(recoveryBDiagnostics)).toBe(baselineDiagnostics.overallText);
  expect(recoveryBDiagnostics.reportText.includes("List failed"), JSON.stringify(recoveryBDiagnostics)).toBe(false);
  expect(recoveryBDiagnostics.firstFailure, JSON.stringify(recoveryBDiagnostics)).toBe(baselineDiagnostics.firstFailure);
  evidence.recordAssertionEvidence(
    "Connect recovered automatically after outage B without re-authentication",
    `${recoveryBWire.length} successful post-clear request(s); Connect=${JSON.stringify(recoveryBConnect)}; sidebar=${JSON.stringify(recoveryBSidebar)}; diagnostics List failed=false and overall returned to baseline ${JSON.stringify(baselineDiagnostics.overallText)}; organization=${recoveryBDen.activeOrgId}.`,
    recoveryBWire.length > 0
      && recoveryBConnect.ok
      && recoveryBConnect.connectEnabled === true
      && recoveryBSidebar.connectState === "ready"
      && recoveryBDiagnosticsMatchesBaseline
      && recoveryBDen.authTokenPresent
      && recoveryBDen.activeOrgId === orgId,
  );
  console.log("[den-outage-spec] recovery B verified");

  const finalEngine = await waitForEngine(desktopApp, "final unchanged healthy engine", baselineEngine);
  expect(finalEngine).toEqual(baselineEngine);
  const everyAuthSampleRetained = authSamples.every(
    (state) => state.authTokenPresent && state.activeOrgId === orgId,
  );
  expect(everyAuthSampleRetained).toBe(true);
  evidence.recordAssertionEvidence(
    "The local OpenCode engine never restarted across two full outage and recovery cycles",
    `Baseline engine ${JSON.stringify(baselineEngine)} equals final engine ${JSON.stringify(finalEngine)}.`,
    sameEngine(finalEngine, baselineEngine),
  );
  evidence.recordAssertionEvidence(
    "No sampled phase required re-authentication or changed the active organization",
    `${authSamples.length} phase samples all retained an auth token and organization ${orgId}.`,
    everyAuthSampleRetained,
  );

  const finalLog = await proxy.requestLog();
  const phaseCounts = {
    outageA: finalLog.filter(
      (request) => request.faulted && request.status === 503
        && request.at >= outageAStart && request.at < recoveryAStart,
    ).length,
    recoveryA: finalLog.filter(
      (request) => !request.faulted && request.status < 400
        && request.at >= recoveryAStart && request.at < outageBStart,
    ).length,
    outageB: finalLog.filter(
      (request) => request.faulted && request.status === 503
        && request.at >= outageBStart && request.at < recoveryBStart,
    ).length,
    recoveryB: finalLog.filter(
      (request) => !request.faulted && request.status < 400 && request.at >= recoveryBStart,
    ).length,
  };
  expect(phaseCounts.outageA).toBeGreaterThan(0);
  expect(phaseCounts.recoveryA).toBeGreaterThan(0);
  expect(phaseCounts.outageB).toBeGreaterThan(0);
  expect(phaseCounts.recoveryB).toBeGreaterThan(0);
  evidence.recordAssertionEvidence(
    "The wire log proves two distinct outage and recovery cycles",
    `Authoritative request-log phase counts: ${JSON.stringify(phaseCounts)}.`,
    Object.values(phaseCounts).every((count) => count > 0),
  );

  await revealDiagnosticsReport(desktopApp);
  const recoveryBShot = await screenshot(desktopApp);
  const recoveryBSeen = await validate(recoveryBShot, [
    "The diagnostics report visibly shows an overall status with no failed check named",
    "The desktop remains usable without a restart or re-authentication screen",
  ]);
  expect(recoveryBSeen.ok, recoveryBSeen.why).toBe(true);
  console.log("[den-outage-spec] final assertions done");
});
