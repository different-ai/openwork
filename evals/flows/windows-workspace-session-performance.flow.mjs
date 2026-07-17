import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/windows-workspace-session-performance.md).
// The runner fails this flow if the narration drifts from that script.
const FLOW_ID = "windows-workspace-session-performance";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const JOB_GLOBAL = "__openworkWindowsWorkspaceSessionPerformance";
const DEFAULT_ROOT = "C:\\ow\\openwork-perf";
const DEFAULTS = {
  workspaces: 3,
  sessionsPerWorkspace: 20,
  concurrency: 4,
  conversations: 4,
  timeoutMs: 10 * 60 * 1000,
  maxRouteReadyMs: 5_000,
  maxSwitchP95Ms: 5_000,
  maxEventLoopP95Ms: 100,
  maxEventAborts: 100,
  maxJsHeapMb: 512,
};

const state = {
  params: null,
  runtime: null,
  perfBefore: null,
  perfAfterSetup: null,
  perfAfterConversations: null,
  setup: null,
  activationRouteReadyMs: null,
  ui: null,
  conversations: null,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quoted = (value) => JSON.stringify(value);

function requirePositiveInt(env, name, defaultValue) {
  const raw = typeof env[name] === "string" ? env[name].trim() : "";
  if (!raw) return defaultValue;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer, got ${quoted(raw)}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a safe positive integer, got ${quoted(raw)}.`);
  }
  return value;
}

function requireNonNegativeInt(env, name, defaultValue) {
  const raw = typeof env[name] === "string" ? env[name].trim() : "";
  if (!raw) return defaultValue;
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer, got ${quoted(raw)}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a safe non-negative integer, got ${quoted(raw)}.`);
  }
  return value;
}

function safeRunSegment(value) {
  return String(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "default";
}

function readParams(ctx) {
  if (state.params) return state.params;
  const runId = ctx.env.OPENWORK_PERF_RUN_ID?.trim() || "default";
  const provider = ctx.env.OPENWORK_PERF_PROVIDER?.trim() || "";
  const model = ctx.env.OPENWORK_PERF_MODEL?.trim() || "";
  if ((provider && !model) || (!provider && model)) {
    throw new Error("OPENWORK_PERF_PROVIDER and OPENWORK_PERF_MODEL must be supplied together, or both omitted.");
  }
  state.params = {
    runId,
    safeRunId: safeRunSegment(runId),
    root: ctx.env.OPENWORK_PERF_ROOT?.trim() || DEFAULT_ROOT,
    workspaces: requirePositiveInt(ctx.env, "OPENWORK_PERF_WORKSPACES", DEFAULTS.workspaces),
    sessionsPerWorkspace: requirePositiveInt(ctx.env, "OPENWORK_PERF_SESSIONS_PER_WORKSPACE", DEFAULTS.sessionsPerWorkspace),
    concurrency: requirePositiveInt(ctx.env, "OPENWORK_PERF_CONCURRENCY", DEFAULTS.concurrency),
    conversations: requirePositiveInt(ctx.env, "OPENWORK_PERF_CONVERSATIONS", DEFAULTS.conversations),
    timeoutMs: requirePositiveInt(ctx.env, "OPENWORK_PERF_TIMEOUT_MS", DEFAULTS.timeoutMs),
    maxRouteReadyMs: requirePositiveInt(ctx.env, "OPENWORK_PERF_MAX_ROUTE_READY_MS", DEFAULTS.maxRouteReadyMs),
    maxSwitchP95Ms: requirePositiveInt(ctx.env, "OPENWORK_PERF_MAX_SWITCH_P95_MS", DEFAULTS.maxSwitchP95Ms),
    maxEventLoopP95Ms: requirePositiveInt(ctx.env, "OPENWORK_PERF_MAX_EVENT_LOOP_P95_MS", DEFAULTS.maxEventLoopP95Ms),
    maxEventAborts: requireNonNegativeInt(ctx.env, "OPENWORK_PERF_MAX_EVENT_ABORTS", DEFAULTS.maxEventAborts),
    maxJsHeapMb: requirePositiveInt(ctx.env, "OPENWORK_PERF_MAX_JS_HEAP_MB", DEFAULTS.maxJsHeapMb),
    requireOutOfWindowSession: ctx.env.OPENWORK_PERF_REQUIRE_OUT_OF_WINDOW_SESSION?.trim() === "1",
    provider: provider || null,
    model: model || null,
  };
  return state.params;
}

function latencySummary(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, p50: null, p95: null, p99: null, max: null };
  const pick = (percentile) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1))];
  return {
    count: sorted.length,
    p50: pick(50),
    p95: pick(95),
    p99: pick(99),
    max: sorted[sorted.length - 1],
  };
}

function recordAssertion(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : JSON.stringify(actual).slice(0, 1_200),
  });
  ctx.assert(condition, `${assertion}${actual === undefined ? "" : `. Actual: ${JSON.stringify(actual).slice(0, 600)}`}`);
}

function sanitizePerformanceMetrics(payload) {
  const metrics = Array.isArray(payload?.metrics) ? payload.metrics : [];
  return Object.fromEntries(metrics.map((item) => [item.name, item.value]));
}

function performanceMetricMiB(perf, name) {
  const value = perf?.metrics?.[name];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round((value / 1024 / 1024) * 100) / 100
    : null;
}

async function getPerformanceMetrics(ctx, label) {
  ctx.assert(Boolean(ctx.client?.send), "CDP client is required for Performance metrics.");
  await ctx.client.send("Performance.enable");
  const raw = await ctx.client.send("Performance.getMetrics");
  return { label, capturedAt: new Date().toISOString(), metrics: sanitizePerformanceMetrics(raw), raw };
}

async function waitForControl(ctx, timeoutMs = 90_000) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs, label: "OpenWork control API" });
}

async function dismissOpenWorkModelsPromo(ctx) {
  const promoText = "Use OpenWork Models without API keys";
  if (!(await ctx.hasText(promoText))) return;
  await ctx.clickText("Continue without OpenWork Models");
  await ctx.waitFor(`!document.body.innerText.includes(${quoted(promoText)})`, {
    timeoutMs: 20_000,
    label: "OpenWork Models promo dismissed",
  });
}

async function waitForWorkspaceRouteReady(ctx, workspaceId, sessionId = "") {
  const routeNeedle = sessionId ? `/workspace/${workspaceId}/session/${sessionId}` : `/workspace/${workspaceId}/session`;
  await ctx.waitFor(`(() => {
    const text = document.body?.innerText || "";
    const hash = window.location.hash || "";
    const route = window.__openworkControl?.snapshot?.().route || "";
    return hash.includes(${quoted(routeNeedle)}) &&
      route.includes(${quoted(routeNeedle)}) &&
      text.trim().length > 40 &&
      !text.includes("Preparing workspace") &&
      !text.includes("Pulling in the latest messages") &&
      !text.includes("Something went wrong");
  })()`, { timeoutMs: 90_000, label: `workspace route ready ${routeNeedle}` });
}

async function waitForBenchmarkSessionReady(ctx, workspaceId, session) {
  const routeNeedle = `/workspace/${workspaceId}/session/${session.sessionId}`;
  return ctx.waitFor(`(() => {
    const sessionId = ${quoted(session.sessionId)};
    const expectedTitle = ${quoted(session.title)};
    const text = document.body?.innerText || "";
    const hashPath = (window.location.hash || "").replace(/^#/, "").split(/[?#]/)[0];
    const routePath = (window.__openworkControl?.snapshot?.().route || "").split(/[?#]/)[0];
    const surface = Array.from(document.querySelectorAll("[data-session-surface-id]"))
      .find((element) => element.getAttribute("data-session-surface-id") === sessionId);
    const surfaceRect = surface?.getBoundingClientRect?.();
    const surfaceVisible = Boolean(surfaceRect && surfaceRect.width > 0 && surfaceRect.height > 0);
    const activeTab = Array.from(document.querySelectorAll('[data-session-tab-id][data-session-tab-active="true"]'))
      .find((element) => element.getAttribute("data-session-tab-id") === sessionId);
    const activeTabTitle = activeTab?.querySelector('button[title]')?.textContent?.trim() || "";
    const headerTitle = document.querySelector('[data-slot="sidebar-inset"] header h1')?.textContent?.trim() || "";
    const routeState = window.__openwork?.slice?.("route");
    const routeSession = routeState?.sessionsByWorkspaceId?.[${quoted(workspaceId)}]
      ?.find((item) => item?.id === sessionId);
    const ready = hashPath === ${quoted(routeNeedle)} &&
      routePath === ${quoted(routeNeedle)} &&
      surfaceVisible &&
      Boolean(activeTab) &&
      activeTabTitle === expectedTitle &&
      headerTitle === expectedTitle &&
      routeSession?.title === expectedTitle &&
      !text.includes("Preparing workspace") &&
      !text.includes("Pulling in the latest messages") &&
      !text.includes("Something went wrong");
    return ready ? { hashPath, routePath, sessionId, expectedTitle, surfaceVisible, activeTab: true, activeTabTitle, headerTitle, routeSessionTitle: routeSession.title } : null;
  })()`, { timeoutMs: 90_000, label: `benchmark session ready ${session.sessionId}` });
}

async function activateVisibleWorkspace(ctx, setup) {
  const startedAt = Date.now();
  const workspaceId = setup.firstWorkspaceId;
  const model = setup.model ?? null;
  await ctx.eval(`(async () => {
    const bridge = window.__OPENWORK_ELECTRON__?.invokeDesktop;
    if (!bridge) throw new Error("desktop bridge missing");
    await bridge("workspaceSetSelected", ${quoted(workspaceId)}).catch(() => null);
    await bridge("workspaceSetRuntimeActive", ${quoted(workspaceId)}).catch(() => null);
    localStorage.setItem("openwork.react.activeWorkspace", ${quoted(workspaceId)});
    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem("openwork.preferences") || "{}"); } catch { prefs = {}; }
    const nextPrefs = {
      ...prefs,
      hasCompletedOnboarding: true,
      providerStepCompleted: true,
      selectedAgent: "openwork",
      ${model ? `defaultModel: { providerID: ${quoted(model.provider)}, modelID: ${quoted(model.model)} },` : ""}
    };
    localStorage.setItem("openwork.preferences", JSON.stringify(nextPrefs));
    ${model ? `localStorage.setItem("openwork.defaultModel", ${quoted(`${model.provider}/${model.model}`)});` : ""}
    window.location.hash = ${quoted(`#/workspace/${workspaceId}/session`)};
    window.location.reload();
    return true;
  })()`, { awaitPromise: true });
  await waitForControl(ctx);
  await waitForWorkspaceRouteReady(ctx, workspaceId);
  await dismissOpenWorkModelsPromo(ctx);
  return Date.now() - startedAt;
}

async function installFetchProbe(ctx, label) {
  return ctx.eval(`(() => {
    const key = "__openworkWindowsPerfFetchProbe";
    if (!window[key]) {
      const originalFetch = window.fetch.bind(window);
      const probe = { originalFetch, records: [], label: "", installedAt: Date.now() };
      const wrapped = async (input, init) => {
        const startedAt = performance.now();
        const urlText = typeof input === "string" ? input : input?.url || String(input);
        const method = String(init?.method || input?.method || "GET").toUpperCase();
        let path = urlText;
        try {
          const url = new URL(urlText, window.location.href);
          path = url.pathname;
        } catch {}
        try {
          const response = await originalFetch(input, init);
          probe.records.push({ at: Date.now(), method, path, status: response.status, durationMs: Math.round(performance.now() - startedAt) });
          return response;
        } catch (error) {
          const errorName = error instanceof Error ? error.name : "Error";
          const errorMessage = error instanceof Error ? error.message : String(error);
          const aborted = errorName === "AbortError" || /\babort(?:ed)?\b/i.test(errorMessage);
          probe.records.push({
            at: Date.now(),
            method,
            path,
            status: null,
            durationMs: Math.round(performance.now() - startedAt),
            errorName,
            error: errorMessage,
            aborted,
          });
          throw error;
        }
      };
      try { Object.assign(wrapped, originalFetch); } catch {}
      probe.wrapped = wrapped;
      window[key] = probe;
      window.fetch = wrapped;
    }
    window[key].label = ${quoted(label)};
    window[key].records.length = 0;
    return { installed: true, label: window[key].label };
  })()`);
}

async function fetchProbeSummary(ctx) {
  return ctx.eval(`(() => {
    const probe = window.__openworkWindowsPerfFetchProbe;
    if (!probe) return { installed: false, records: [], summary: null };
    const records = probe.records.slice();
    const counts = {};
    const abortedByPath = {};
    for (const record of records) {
      const key = record.status == null ? "error" : String(record.status);
      counts[key] = (counts[key] || 0) + 1;
      if (record.aborted) abortedByPath[record.path] = (abortedByPath[record.path] || 0) + 1;
    }
    return {
      installed: true,
      label: probe.label,
      records,
      summary: {
        count: records.length,
        statuses: counts,
        aborted: records.filter((record) => record.aborted).length,
        abortedByPath,
        unexpectedErrors: records.filter((record) => record.status == null && !record.aborted).length,
      },
    };
  })()`);
}

async function measureEventLoopLag(ctx, durationMs = 2_000, intervalMs = 50) {
  return ctx.eval(`new Promise((resolve) => {
    const durationMs = ${durationMs};
    const intervalMs = ${intervalMs};
    const lags = [];
    const startedAt = performance.now();
    let expected = startedAt + intervalMs;
    const tick = () => {
      const now = performance.now();
      lags.push(Math.max(0, Math.round(now - expected)));
      expected += intervalMs;
      if (now - startedAt >= durationMs) {
        const sorted = lags.slice().sort((a, b) => a - b);
        const pick = (percentile) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1))] ?? null;
        resolve({ samples: lags.length, p50: pick(50), p95: pick(95), p99: pick(99), max: sorted[sorted.length - 1] ?? null });
        return;
      }
      setTimeout(tick, Math.max(0, expected - performance.now()));
    };
    setTimeout(tick, intervalMs);
  })`, { awaitPromise: true });
}

async function measureSessionSwitches(ctx, workspaceId, sessions) {
  const selected = sessions.slice(0, Math.min(10, sessions.length));
  const records = [];
  for (const session of selected) {
    const startedAt = Date.now();
    await ctx.control("session.open", { sessionId: session.sessionId });
    const readiness = await waitForBenchmarkSessionReady(ctx, workspaceId, session);
    records.push({
      sessionId: session.sessionId,
      title: session.title,
      indexedBeforeOpen: session.indexedBeforeOpen,
      durationMs: Date.now() - startedAt,
      route: await ctx.eval("window.__openworkControl.snapshot().route"),
      readiness,
    });
  }
  return { count: records.length, records, latencyMs: latencySummary(records.map((record) => record.durationMs)) };
}

function startRendererJob(ctx, name, params, worker) {
  return ctx.eval(`(() => {
    const key = ${quoted(JOB_GLOBAL)};
    const jobs = window[key] || (window[key] = {});
    const job = {
      name: ${quoted(name)},
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      progress: [],
      result: null,
      error: null,
      stack: null,
    };
    jobs[${quoted(name)}] = job;
    const worker = ${worker.toString()};
    const emit = (entry) => {
      job.progress.push({ at: Date.now(), ...entry });
      if (job.progress.length > 100) job.progress.splice(0, job.progress.length - 100);
    };
    Promise.resolve()
      .then(() => worker(${JSON.stringify(params)}, emit))
      .then((result) => {
        job.status = "passed";
        job.finishedAt = Date.now();
        job.result = result;
      })
      .catch((error) => {
        job.status = "failed";
        job.finishedAt = Date.now();
        job.error = error instanceof Error ? error.message : String(error);
        job.stack = error instanceof Error && error.stack ? String(error.stack).slice(0, 4000) : null;
      });
    return { name: job.name, status: job.status, startedAt: job.startedAt };
  })()`);
}

async function pollRendererJob(ctx, name, timeoutMs) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await ctx.eval(`(() => {
      const job = window[${quoted(JOB_GLOBAL)}]?.[${quoted(name)}];
      if (!job) return null;
      return {
        name: job.name,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        progress: job.progress.slice(-12),
        result: job.status === "passed" ? job.result : null,
        error: job.error,
        stack: job.stack,
      };
    })()`);
    if (last?.status === "passed") return last.result;
    if (last?.status === "failed") {
      throw new Error(`Renderer job ${name} failed: ${last.error}${last.stack ? `\n${last.stack}` : ""}`);
    }
    await sleep(1_000);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for renderer job ${name}. Last state: ${JSON.stringify(last)}`);
}

function setupWorker(params, emit) {
  const round = (value) => Math.round(value);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pad = (value) => String(value).padStart(3, "0");
  const windowsJoin = (base, child) => `${String(base).replace(/[\\/]+$/, "")}\\${child}`;
  const requestSummary = (records) => {
    const sorted = records.map((record) => record.durationMs).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    const pick = (percentile) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1))] ?? null;
    const statuses = {};
    const byLabel = {};
    for (const record of records) {
      const key = record.status == null ? "error" : String(record.status);
      statuses[key] = (statuses[key] || 0) + 1;
      const label = byLabel[record.label] || (byLabel[record.label] = { count: 0, errors: 0, statuses: {}, durations: [] });
      label.count += 1;
      if (!record.ok) label.errors += 1;
      label.statuses[key] = (label.statuses[key] || 0) + 1;
      if (Number.isFinite(record.durationMs)) label.durations.push(record.durationMs);
    }
    for (const label of Object.values(byLabel)) {
      const durations = label.durations.sort((a, b) => a - b);
      const labelPick = (percentile) => durations[Math.min(durations.length - 1, Math.max(0, Math.ceil((percentile / 100) * durations.length) - 1))] ?? null;
      label.latencyMs = { count: durations.length, p50: labelPick(50), p95: labelPick(95), p99: labelPick(99), max: durations[durations.length - 1] ?? null };
      delete label.durations;
    }
    return {
      count: records.length,
      errors: records.filter((record) => !record.ok).length,
      statuses,
      latencyMs: { count: sorted.length, p50: pick(50), p95: pick(95), p99: pick(99), max: sorted[sorted.length - 1] ?? null },
      byLabel,
    };
  };
  const runPool = async (items, concurrency, worker) => {
    const results = new Array(items.length);
    let next = 0;
    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    const workers = [];
    for (let index = 0; index < workerCount; index += 1) {
      workers.push((async () => {
        while (next < items.length) {
          const current = next;
          next += 1;
          try {
            results[current] = { ok: true, value: await worker(items[current], current) };
          } catch (error) {
            results[current] = { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        }
      })());
    }
    await Promise.all(workers);
    return results;
  };

  return (async () => {
    const startedAt = performance.now();
    const deadlineAt = Date.now() + params.timeoutMs;
    const records = [];
    const assertDeadline = () => {
      if (Date.now() > deadlineAt) throw new Error(`Benchmark setup exceeded ${params.timeoutMs}ms.`);
    };
    const bridge = window.__OPENWORK_ELECTRON__?.invokeDesktop;
    if (!bridge) throw new Error("OpenWork Electron desktop bridge is missing.");
    let connection = null;
    const refreshConnection = async (reason) => {
      const info = await bridge("openworkServerInfo");
      if (!info?.running || !info.port) throw new Error(`Embedded OpenWork server is not running after ${reason}.`);
      const clientToken = typeof info.clientToken === "string" && info.clientToken ? info.clientToken : "";
      const ownerToken = typeof info.ownerToken === "string" && info.ownerToken ? info.ownerToken : "";
      const hostToken = typeof info.hostToken === "string" && info.hostToken ? info.hostToken : "";
      if (!clientToken && !ownerToken) throw new Error(`OpenWork client token is unavailable after ${reason}.`);
      if (!hostToken && !ownerToken) throw new Error(`OpenWork host authentication is unavailable after ${reason}.`);
      connection = {
        baseUrl: `http://127.0.0.1:${info.port}`,
        port: info.port,
        pid: info.pid ?? null,
        clientToken,
        ownerToken,
        hostToken,
      };
      return { baseUrl: connection.baseUrl, port: connection.port, pid: connection.pid, reason };
    };
    const initialServer = await refreshConnection("initial setup");
    const perRequestTimeoutMs = Math.min(params.timeoutMs, 120_000);
    const headersFor = (auth) => {
      if (!connection) throw new Error("OpenWork server connection is not initialized.");
      const headers = { "content-type": "application/json" };
      if (auth === "host") {
        if (connection.hostToken) headers["x-openwork-host-token"] = connection.hostToken;
        else headers.authorization = `Bearer ${connection.ownerToken}`;
        return headers;
      }
      headers.authorization = `Bearer ${connection.ownerToken || connection.clientToken}`;
      return headers;
    };
    const requestJson = async (label, path, options = {}, auth = "client") => {
      assertDeadline();
      const method = String(options.method || "GET").toUpperCase();
      const started = performance.now();
      let status = null;
      let recorded = false;
      try {
        if (!connection) throw new Error("OpenWork server connection is not initialized.");
        const response = await fetch(`${connection.baseUrl}${path}`, {
          method,
          headers: headersFor(auth),
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(perRequestTimeoutMs),
        });
        status = response.status;
        const text = await response.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        const record = { label, method, path, status, ok: response.ok, durationMs: round(performance.now() - started) };
        records.push(record);
        recorded = true;
        if (!response.ok) throw new Error(`${method} ${path} -> ${status}: ${typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)}`);
        return { body, status, durationMs: record.durationMs };
      } catch (error) {
        if (!recorded) records.push({ label, method, path, status, ok: false, durationMs: round(performance.now() - started), error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
        throw error;
      }
    };

    const runRoot = windowsJoin(params.root, `${params.flowId}-${params.safeRunId}`);
    const workspaceSpecs = [];
    for (let index = 1; index <= params.workspaces; index += 1) {
      const ordinal = pad(index);
      workspaceSpecs.push({
        workspaceIndex: index,
        ordinal,
        path: windowsJoin(runRoot, `workspace-${ordinal}`),
        name: `ow-perf-${params.safeRunId}-ws-${ordinal}`,
        sessionTitlePrefix: `ow-perf:${params.safeRunId}:ws-${ordinal}:session-`,
      });
    }

    emit({ stage: "workspaces.create", total: workspaceSpecs.length });
    // Workspace registration mutates one persisted registry; keep fixture setup
    // serial so the measured concurrency is session and model work, not a setup race.
    const workspaceResults = await runPool(workspaceSpecs, 1, async (spec) => {
      const created = await requestJson("workspace.create", "/workspaces/local", {
        method: "POST",
        body: { folderPath: spec.path, name: spec.name, preset: "starter" },
      }, "host");
      const workspaces = Array.isArray(created.body?.workspaces) ? created.body.workspaces : [];
      const match = workspaces.find((workspace) => workspace?.path === spec.path) || workspaces.find((workspace) => workspace?.id === created.body?.activeId) || workspaces[0];
      const id = created.body?.activeId || created.body?.selectedId || match?.id;
      if (typeof id !== "string" || !id.trim()) throw new Error(`Workspace create returned no id for ${spec.path}.`);
      return { ...spec, id };
    });
    const workspaceErrors = workspaceResults.filter((result) => !result.ok);
    if (workspaceErrors.length) throw new Error(`Workspace creation failed: ${JSON.stringify(workspaceErrors)}`);
    const workspaces = workspaceResults.map((result) => result.value);
    const firstWorkspace = workspaces[0];
    await requestJson("workspace.activate", `/workspaces/${encodeURIComponent(firstWorkspace.id)}/activate?persist=true`, { method: "POST" }, "host");

    emit({ stage: "engine.start", workspace: firstWorkspace.ordinal });
    const engineStartedAt = performance.now();
    await bridge("workspaceCreate", {
      folderPath: firstWorkspace.path,
      name: firstWorkspace.name,
      preset: "starter",
    });
    await bridge("workspaceSetSelected", firstWorkspace.id);
    await bridge("workspaceSetRuntimeActive", firstWorkspace.id);
    const engine = await bridge("engineStart", firstWorkspace.path, {
      runtime: "direct",
      workspacePaths: workspaces.map((workspace) => workspace.path),
    });
    const engineStartMs = round(performance.now() - engineStartedAt);
    if (!engine?.baseUrl) throw new Error(`Managed OpenCode engine did not report a base URL: ${JSON.stringify(engine)}`);
    const serverAfterEngineStart = await refreshConnection("engineStart");
    const registered = await requestJson("workspaces.list", "/workspaces", {}, "client");
    const registeredItems = Array.isArray(registered.body?.items)
      ? registered.body.items
      : Array.isArray(registered.body?.workspaces)
        ? registered.body.workspaces
        : [];
    const registeredWorkspaceTotal = registeredItems.length;

    const workspaceSummaries = [];
    let createdSessionTotal = 0;
    for (const workspace of workspaces) {
      emit({ stage: "sessions.list", workspace: workspace.ordinal });
      const listLimit = Math.max(params.sessionsPerWorkspace * 3, 100);
      const listed = await requestJson("session.list", `/workspace/${encodeURIComponent(workspace.id)}/sessions?limit=${listLimit}`, {}, "client");
      const items = Array.isArray(listed.body?.items) ? listed.body.items : [];
      const existing = items.filter((session) => typeof session?.title === "string" && session.title.startsWith(workspace.sessionTitlePrefix));
      const existingTitles = new Set(existing.map((session) => session.title));
      const missing = [];
      for (let index = 1; index <= params.sessionsPerWorkspace; index += 1) {
        const title = `${workspace.sessionTitlePrefix}${pad(index)}`;
        if (!existingTitles.has(title)) missing.push({ title });
      }
      const toCreate = missing.slice(0, Math.max(0, params.sessionsPerWorkspace - existing.length));
      emit({ stage: "sessions.create", workspace: workspace.ordinal, existing: existing.length, creating: toCreate.length });
      const created = await runPool(toCreate, params.concurrency, async (plan) => {
        const response = await requestJson("session.create", `/workspace/${encodeURIComponent(workspace.id)}/opencode/session`, {
          method: "POST",
          body: { title: plan.title },
        }, "client");
        const id = response.body?.id || response.body?.session?.id;
        if (typeof id !== "string" || !id.trim()) throw new Error(`Session create returned no id for ${plan.title}.`);
        return { sessionId: id, title: plan.title };
      });
      const createErrors = created.filter((result) => !result.ok);
      if (createErrors.length) throw new Error(`Session creation failed for ${workspace.id}: ${JSON.stringify(createErrors)}`);
      createdSessionTotal += created.length;

      const finalList = await requestJson("session.list.final", `/workspace/${encodeURIComponent(workspace.id)}/sessions?limit=${listLimit + toCreate.length + 20}`, {}, "client");
      const finalItems = Array.isArray(finalList.body?.items) ? finalList.body.items : [];
      const benchmark = finalItems
        .filter((session) => typeof session?.title === "string" && session.title.startsWith(workspace.sessionTitlePrefix) && typeof session.id === "string")
        .sort((left, right) => String(left.title).localeCompare(String(right.title)));
      if (benchmark.length < params.sessionsPerWorkspace) {
        throw new Error(`Workspace ${workspace.id} has ${benchmark.length} benchmark sessions, expected ${params.sessionsPerWorkspace}.`);
      }
      workspaceSummaries.push({
        workspaceIndex: workspace.workspaceIndex,
        id: workspace.id,
        name: workspace.name,
        path: workspace.path,
        targetSessions: params.sessionsPerWorkspace,
        existingBenchmarkSessions: existing.length,
        createdBenchmarkSessions: created.length,
        benchmarkSessionCount: benchmark.length,
        totalListedSessions: finalItems.length,
        sampleSessions: benchmark
          .slice(0, workspace.workspaceIndex === 1 ? benchmark.length : 20)
          .map((session) => ({ sessionId: session.id, title: session.title })),
      });
    }

    return {
      runId: params.runId,
      safeRunId: params.safeRunId,
      root: params.root,
      runRoot,
      params: {
        workspaces: params.workspaces,
        sessionsPerWorkspace: params.sessionsPerWorkspace,
        concurrency: params.concurrency,
        timeoutMs: params.timeoutMs,
        maxRouteReadyMs: params.maxRouteReadyMs,
        maxSwitchP95Ms: params.maxSwitchP95Ms,
        maxEventLoopP95Ms: params.maxEventLoopP95Ms,
        maxEventAborts: params.maxEventAborts,
        maxJsHeapMb: params.maxJsHeapMb,
        requireOutOfWindowSession: params.requireOutOfWindowSession,
      },
      server: { initial: initialServer, afterEngineStart: serverAfterEngineStart },
      firstWorkspaceId: firstWorkspace.id,
      firstWorkspacePath: firstWorkspace.path,
      workspaces: workspaceSummaries,
      workspaceCount: workspaceSummaries.length,
      registeredWorkspaceTotal,
      targetSessionTotal: params.workspaces * params.sessionsPerWorkspace,
      benchmarkSessionTotal: workspaceSummaries.reduce((sum, workspace) => sum + workspace.benchmarkSessionCount, 0),
      createdSessionTotal,
      engine: { started: true, engineStartMs },
      requestSummary: requestSummary(records),
      requests: records,
      wallMs: round(performance.now() - startedAt),
    };
  })();
}

function conversationWorker(params, emit) {
  const round = (value) => Math.round(value);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pad = (value) => String(value).padStart(3, "0");
  const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const requestSummary = (records) => {
    const sorted = records.map((record) => record.durationMs).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    const pick = (percentile) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1))] ?? null;
    const statuses = {};
    const byLabel = {};
    for (const record of records) {
      const key = record.status == null ? "error" : String(record.status);
      statuses[key] = (statuses[key] || 0) + 1;
      const label = byLabel[record.label] || (byLabel[record.label] = { count: 0, errors: 0, statuses: {}, durations: [] });
      label.count += 1;
      if (!record.ok) label.errors += 1;
      label.statuses[key] = (label.statuses[key] || 0) + 1;
      if (Number.isFinite(record.durationMs)) label.durations.push(record.durationMs);
    }
    for (const label of Object.values(byLabel)) {
      const durations = label.durations.sort((a, b) => a - b);
      const labelPick = (percentile) => durations[Math.min(durations.length - 1, Math.max(0, Math.ceil((percentile / 100) * durations.length) - 1))] ?? null;
      label.latencyMs = { count: durations.length, p50: labelPick(50), p95: labelPick(95), p99: labelPick(99), max: durations[durations.length - 1] ?? null };
      delete label.durations;
    }
    return { count: records.length, errors: records.filter((record) => !record.ok).length, statuses, latencyMs: { count: sorted.length, p50: pick(50), p95: pick(95), p99: pick(99), max: sorted[sorted.length - 1] ?? null }, byLabel };
  };
  const latencySummary = (values) => {
    const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    const pick = (percentile) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1))] ?? null;
    return { count: sorted.length, p50: pick(50), p95: pick(95), p99: pick(99), max: sorted[sorted.length - 1] ?? null };
  };
  const runPool = async (items, concurrency, worker) => {
    const results = new Array(items.length);
    let next = 0;
    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    const workers = [];
    for (let index = 0; index < workerCount; index += 1) {
      workers.push((async () => {
        while (next < items.length) {
          const current = next;
          next += 1;
          try {
            results[current] = { ok: true, value: await worker(items[current], current) };
          } catch (error) {
            results[current] = { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        }
      })());
    }
    await Promise.all(workers);
    return results;
  };
  const textFromMessage = (message) => {
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    return parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("")
      .trim();
  };
  const assistantTexts = (messages) => messages
    .filter((message) => message?.info?.role === "assistant" || message?.role === "assistant")
    .map(textFromMessage)
    .filter(Boolean);
  const statusType = (status) => typeof status === "string" ? status : (status && typeof status === "object" ? status.type : "idle");
  const isLiveStatus = (status) => {
    const type = statusType(status);
    return type === "busy" || type === "running" || type === "retry";
  };

  return (async () => {
    const startedAt = performance.now();
    const deadlineAt = Date.now() + params.timeoutMs;
    const records = [];
    const assertDeadline = () => {
      if (Date.now() > deadlineAt) throw new Error(`Conversation benchmark exceeded ${params.timeoutMs}ms.`);
    };
    const bridge = window.__OPENWORK_ELECTRON__?.invokeDesktop;
    if (!bridge) throw new Error("OpenWork Electron desktop bridge is missing.");
    const info = await bridge("openworkServerInfo");
    if (!info?.running || !info.port) throw new Error("Embedded OpenWork server is not running.");
    const clientToken = typeof info.clientToken === "string" && info.clientToken ? info.clientToken : "";
    const ownerToken = typeof info.ownerToken === "string" && info.ownerToken ? info.ownerToken : "";
    if (!clientToken && !ownerToken) throw new Error("OpenWork client token is unavailable inside the renderer.");
    const baseUrl = `http://127.0.0.1:${info.port}`;
    const perRequestTimeoutMs = Math.min(params.timeoutMs, 120_000);
    const headers = { "content-type": "application/json", authorization: `Bearer ${ownerToken || clientToken}` };
    const requestJson = async (label, path, options = {}) => {
      assertDeadline();
      const method = String(options.method || "GET").toUpperCase();
      const started = performance.now();
      let status = null;
      let recorded = false;
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(perRequestTimeoutMs),
        });
        status = response.status;
        const text = await response.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        const record = { label, method, path, status, ok: response.ok, durationMs: round(performance.now() - started) };
        records.push(record);
        recorded = true;
        if (!response.ok) throw new Error(`${method} ${path} -> ${status}: ${typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)}`);
        return { body, status, durationMs: record.durationMs };
      } catch (error) {
        if (!recorded) records.push({ label, method, path, status, ok: false, durationMs: round(performance.now() - started), error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
        throw error;
      }
    };
    const modelIds = (provider) => {
      if (!provider || typeof provider !== "object") return [];
      if (provider.models && typeof provider.models === "object" && !Array.isArray(provider.models)) return Object.keys(provider.models);
      if (Array.isArray(provider.models)) return provider.models.map((model) => typeof model === "string" ? model : model?.id).filter(Boolean);
      return [];
    };
    const chooseModel = (body) => {
      const all = Array.isArray(body?.all) ? body.all : (Array.isArray(body?.providers) ? body.providers : []);
      const hasConnected = Array.isArray(body?.connected);
      const connected = new Set(hasConnected ? body.connected : all.map((provider) => provider?.id).filter(Boolean));
      const byId = new Map(all.filter((provider) => typeof provider?.id === "string").map((provider) => [provider.id, provider]));
      const available = (providerId, modelId) => {
        const provider = byId.get(providerId);
        return Boolean(provider && connected.has(providerId) && modelIds(provider).includes(modelId));
      };
      if (params.provider || params.model) {
        if (!params.provider || !params.model) throw new Error("Explicit provider/model must be supplied together.");
        if (!available(params.provider, params.model)) throw new Error(`Explicit model is not connected/available: ${params.provider}/${params.model}.`);
        const provider = byId.get(params.provider);
        return { provider: params.provider, model: params.model, providerName: provider?.name ?? params.provider, source: "env" };
      }
      const defaults = body?.default && typeof body.default === "object" ? Object.entries(body.default) : [];
      for (const entry of defaults) {
        const providerId = entry[0];
        const rawModel = entry[1];
        const modelId = typeof rawModel === "string" ? rawModel : (rawModel?.modelID || rawModel?.id || "");
        if (providerId && modelId && available(providerId, modelId)) {
          const provider = byId.get(providerId);
          return { provider: providerId, model: modelId, providerName: provider?.name ?? providerId, source: "default" };
        }
      }
      for (const provider of all) {
        if (!provider?.id || !connected.has(provider.id)) continue;
        const models = modelIds(provider);
        if (models.length > 0) return { provider: provider.id, model: models[0], providerName: provider.name ?? provider.id, source: "first-connected" };
      }
      throw new Error(`No connected model is available from /opencode/config/providers: ${JSON.stringify({ connected: body?.connected ?? null, providerCount: all.length })}`);
    };

    emit({ stage: "providers.detect" });
    const providers = await requestJson("providers.list", `/workspace/${encodeURIComponent(params.workspaceId)}/opencode/config/providers`);
    const model = chooseModel(providers.body);
    const conversationTitlePrefix = `ow-perf:${params.safeRunId}:conversation-`;
    emit({ stage: "conversations.cleanup.scan", prefix: conversationTitlePrefix });
    const cleanupList = await requestJson(
      "conversation.cleanup.list",
      `/workspace/${encodeURIComponent(params.workspaceId)}/sessions?limit=1000&search=${encodeURIComponent(conversationTitlePrefix)}`,
    );
    const listedSessions = Array.isArray(cleanupList.body?.items) ? cleanupList.body.items : [];
    const seenCleanupIds = new Set();
    const priorConversationSessions = listedSessions
      .filter((session) => typeof session?.id === "string" && typeof session.title === "string" && session.title.startsWith(conversationTitlePrefix))
      .filter((session) => {
        if (seenCleanupIds.has(session.id)) return false;
        seenCleanupIds.add(session.id);
        return true;
      })
      .map((session) => ({ id: session.id, title: session.title }));
    emit({ stage: "conversations.cleanup.delete", listed: listedSessions.length, deleting: priorConversationSessions.length, prefix: conversationTitlePrefix });
    const cleanupDeleteResults = await runPool(priorConversationSessions, params.concurrency, async (session) => {
      await requestJson("conversation.cleanup.delete", `/workspace/${encodeURIComponent(params.workspaceId)}/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      return session;
    });
    const cleanupDeleteErrors = cleanupDeleteResults.filter((result) => !result.ok);
    if (cleanupDeleteErrors.length) throw new Error(`Conversation cleanup delete failed: ${JSON.stringify(cleanupDeleteErrors)}`);

    const items = [];
    for (let index = 1; index <= params.conversations; index += 1) {
      const marker = `OWPERF_${params.safeRunId}_${pad(index)}`;
      items.push({
        index,
        marker,
        title: `${conversationTitlePrefix}${pad(index)}`,
        prompt: `Reply with exactly ${marker} and no other text. Do not call tools. This is a Windows OpenWork performance isolation check.`,
        sessionId: null,
        created: false,
        accepted: false,
        promptStatus: null,
        promptAcceptanceMs: null,
        timeToFirstAssistantMs: null,
        totalCompletionMs: null,
        sawBusy: false,
        sawAssistant: false,
        finalStatus: null,
        messages: [],
        success: false,
        failure: null,
      });
    }

    emit({ stage: "conversations.create", total: items.length });
    const createResults = await runPool(items, params.concurrency, async (item) => {
      const response = await requestJson("conversation.session.create", `/workspace/${encodeURIComponent(params.workspaceId)}/opencode/session`, {
        method: "POST",
        body: { title: item.title },
      });
      const id = response.body?.id || response.body?.session?.id;
      if (typeof id !== "string" || !id.trim()) throw new Error(`Conversation session create returned no id for ${item.title}.`);
      item.sessionId = id;
      item.created = true;
      return id;
    });
    const createErrors = createResults.filter((result) => !result.ok);
    if (createErrors.length) throw new Error(`Conversation session creation failed: ${JSON.stringify(createErrors)}`);

    emit({ stage: "conversations.prompt", total: items.length, concurrency: params.concurrency });
    const promptResults = await runPool(items, params.concurrency, async (item) => {
      const started = performance.now();
      const response = await requestJson("conversation.prompt_async", `/workspace/${encodeURIComponent(params.workspaceId)}/opencode/session/${encodeURIComponent(item.sessionId)}/prompt_async`, {
        method: "POST",
        body: {
          parts: [{ type: "text", text: item.prompt }],
          model: { providerID: model.provider, modelID: model.model },
        },
      });
      item.accepted = true;
      item.promptStatus = response.status;
      item.promptAcceptanceMs = round(performance.now() - started);
      item.promptAcceptedAt = Date.now();
      return true;
    });
    const promptErrors = promptResults.filter((result) => !result.ok);
    for (let index = 0; index < promptResults.length; index += 1) {
      if (!promptResults[index].ok) items[index].failure = promptResults[index].error;
    }
    if (promptErrors.length) throw new Error(`Prompt acceptance failed: ${JSON.stringify(promptErrors)}`);

    const markers = items.map((item) => item.marker);
    const pending = new Set(items.map((item) => item.sessionId));
    while (pending.size > 0 && Date.now() < deadlineAt) {
      const statusesResponse = await requestJson("conversation.status", `/workspace/${encodeURIComponent(params.workspaceId)}/opencode/session/status`);
      const statuses = statusesResponse.body && typeof statusesResponse.body === "object" ? statusesResponse.body : {};
      const activeItems = items.filter((item) => pending.has(item.sessionId));
      await runPool(activeItems, params.concurrency, async (item) => {
        const status = statuses[item.sessionId] ?? { type: "idle" };
        item.finalStatus = statusType(status);
        if (isLiveStatus(status)) item.sawBusy = true;
        const messages = await requestJson("conversation.messages.poll", `/workspace/${encodeURIComponent(params.workspaceId)}/sessions/${encodeURIComponent(item.sessionId)}/messages?limit=80`);
        item.messages = Array.isArray(messages.body?.items) ? messages.body.items : [];
        const assistants = assistantTexts(item.messages);
        if (assistants.length > 0) {
          item.sawAssistant = true;
          if (item.timeToFirstAssistantMs === null) item.timeToFirstAssistantMs = Math.max(0, Date.now() - item.promptAcceptedAt);
        }
        const exactAssistant = assistants.some((text) => normalizeText(text) === item.marker);
        const allText = item.messages.map(textFromMessage).join("\n");
        const leakedMarkers = markers.filter((marker) => marker !== item.marker && allText.includes(marker));
        if (!isLiveStatus(status) && assistants.length > 0) {
          item.totalCompletionMs = Math.max(0, Date.now() - item.promptAcceptedAt);
          item.success = exactAssistant && leakedMarkers.length === 0 && (item.sawBusy || item.sawAssistant) && !isLiveStatus(status);
          if (!item.success) {
            item.failure = JSON.stringify({ exactAssistant, leakedMarkers, assistantPreview: assistants.map((text) => text.slice(0, 160)), finalStatus: item.finalStatus });
          }
          pending.delete(item.sessionId);
        }
      });
      if (pending.size > 0) await sleep(1_000);
    }
    for (const item of items) {
      if (pending.has(item.sessionId)) {
        item.failure = `Timed out waiting for assistant marker and idle status after ${params.timeoutMs}ms.`;
        item.totalCompletionMs = item.promptAcceptedAt ? Math.max(0, Date.now() - item.promptAcceptedAt) : null;
        pending.delete(item.sessionId);
      }
    }

    const successes = items.filter((item) => item.success);
    const failures = items.filter((item) => !item.success);
    const wallMs = round(performance.now() - startedAt);
    return {
      workspaceId: params.workspaceId,
      provider: model.provider,
      model: model.model,
      providerName: model.providerName,
      modelSource: model.source,
      requested: params.conversations,
      requestedConcurrency: params.concurrency,
      cleanup: {
        titlePrefix: conversationTitlePrefix,
        listedSessionCount: listedSessions.length,
        matchedPriorSessions: priorConversationSessions.length,
        deletedPriorSessions: cleanupDeleteResults.filter((result) => result.ok).length,
        deletedTitles: priorConversationSessions.map((session) => session.title),
      },
      successCount: successes.length,
      failureCount: failures.length,
      timeoutCount: failures.filter((item) => String(item.failure || "").includes("Timed out")).length,
      throughputPerSecond: wallMs > 0 ? Math.round((successes.length / (wallMs / 1000)) * 100) / 100 : null,
      promptAcceptanceMs: latencySummary(items.map((item) => item.promptAcceptanceMs)),
      timeToFirstAssistantMs: latencySummary(items.map((item) => item.timeToFirstAssistantMs)),
      totalCompletionMs: latencySummary(items.map((item) => item.totalCompletionMs)),
      statusCodes: requestSummary(records).statuses,
      requestSummary: requestSummary(records),
      requests: records,
      items: items.map((item) => ({
        index: item.index,
        sessionId: item.sessionId,
        title: item.title,
        marker: item.marker,
        accepted: item.accepted,
        promptStatus: item.promptStatus,
        promptAcceptanceMs: item.promptAcceptanceMs,
        timeToFirstAssistantMs: item.timeToFirstAssistantMs,
        totalCompletionMs: item.totalCompletionMs,
        sawBusy: item.sawBusy,
        sawAssistant: item.sawAssistant,
        finalStatus: item.finalStatus,
        success: item.success,
        failure: item.failure,
        assistantPreview: assistantTexts(item.messages).map((text) => text.slice(0, 200)),
      })),
      representative: successes[0] ? { sessionId: successes[0].sessionId, marker: successes[0].marker, title: successes[0].title } : null,
      wallMs,
    };
  })();
}

export default {
  id: FLOW_ID,
  title: "Windows packaged app stays responsive with many real workspaces, sessions, and concurrent model conversations",
  kind: "internal",
  requiresApp: true,
  preserveTheme: true,
  precondition: async (ctx) => {
    readParams(ctx);
    await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__)", { timeoutMs: 60_000, label: "OpenWork Electron bridge" });
  },
  steps: [
    {
      name: "Frame 1 - packaged Windows baseline",
      run: async (ctx) => {
        const params = readParams(ctx);
        state.perfBefore = await getPerformanceMetrics(ctx, "before");
        await ctx.prove("The eval is attached to a real packaged Windows Electron OpenWork app", {
          voiceover: vo[0],
          action: async () => {
            await waitForControl(ctx);
            await ctx.navigateHash("/settings/general");
            await ctx.waitFor(`window.location.hash.includes("/settings/general")`, {
              timeoutMs: 30_000,
              label: "general settings baseline",
            });
            await dismissOpenWorkModelsPromo(ctx);
            state.runtime = await ctx.eval(`(async () => {
              const bridge = window.__OPENWORK_ELECTRON__;
              const invoke = bridge?.invokeDesktop;
              const arch = await bridge?.system?.getArchitectureInfo?.();
              const build = invoke ? await invoke("appBuildInfo").catch(() => null) : null;
              return {
                hasBridge: Boolean(bridge),
                hasInvoke: Boolean(invoke),
                arch,
                userAgent: navigator.userAgent,
                build: build ? {
                  version: build.version ?? null,
                  gitSha: build.gitSha ?? null,
                  buildEpoch: build.buildEpoch ?? null,
                  openworkDevMode: build.openworkDevMode,
                } : null,
                hash: window.location.hash,
                title: document.title,
              };
            })()`, { awaitPromise: true });
            ctx.output("windows perf parameters", JSON.stringify({ ...params, provider: params.provider ?? "(auto)", model: params.model ?? "(auto)" }, null, 2));
            ctx.output("cdp performance metrics before", JSON.stringify(state.perfBefore.raw, null, 2));
          },
          assert: async () => {
            recordAssertion(ctx, state.runtime?.hasBridge === true && state.runtime?.hasInvoke === true, "window.__OPENWORK_ELECTRON__ and invokeDesktop are available.", state.runtime);
            recordAssertion(ctx, state.runtime?.arch?.platform === "windows", "system.getArchitectureInfo().platform reports windows.", state.runtime?.arch);
            recordAssertion(ctx, typeof state.runtime?.userAgent === "string" && state.runtime.userAgent.includes("Electron"), "The renderer user agent is Electron.", state.runtime?.userAgent);
            recordAssertion(ctx, state.runtime?.build?.openworkDevMode === false, "appBuildInfo reports packaged/not dev mode.", state.runtime?.build);
          },
          screenshot: {
            name: "packaged-windows-baseline",
            requireText: ["Overview of all settings"],
            rejectText: ["Something went wrong", "Use OpenWork Models without API keys"],
            hashIncludes: "/settings/general",
          },
        });
      },
    },
    {
      name: "Dataset ramp through embedded APIs",
      run: async (ctx) => {
        const params = { ...readParams(ctx), flowId: FLOW_ID };
        await startRendererJob(ctx, "setup", params, setupWorker);
        state.setup = await pollRendererJob(ctx, "setup", params.timeoutMs + 30_000);
        recordAssertion(ctx, state.setup.workspaceCount === params.workspaces, "The renderer created or reused the requested benchmark workspaces through /workspaces/local.", { expected: params.workspaces, actual: state.setup.workspaceCount });
        recordAssertion(ctx, Number.isInteger(state.setup.registeredWorkspaceTotal) && state.setup.registeredWorkspaceTotal >= state.setup.workspaceCount, "The server reported total registered workspaces separately from this run's benchmark workspaces.", { registeredWorkspaceTotal: state.setup.registeredWorkspaceTotal, benchmarkWorkspaceCount: state.setup.workspaceCount });
        recordAssertion(ctx, state.setup.benchmarkSessionTotal >= state.setup.targetSessionTotal, "The renderer created or reused enough real benchmark sessions through OpenCode.", { expected: state.setup.targetSessionTotal, actual: state.setup.benchmarkSessionTotal });
        recordAssertion(ctx, state.setup.requestSummary.errors === 0, "Dataset setup completed with zero OpenWork/OpenCode API failures.", state.setup.requestSummary);
        ctx.output("windows setup metrics", JSON.stringify(state.setup, null, 2));
        state.activationRouteReadyMs = await activateVisibleWorkspace(ctx, state.setup);
      },
    },
    {
      name: "Frame 2 - navigable workspace/session scale",
      run: async (ctx) => {
        const firstWorkspace = state.setup.workspaces[0];
        await ctx.waitFor(`(() => {
          const route = window.__openwork?.slice?.("route");
          const workspace = route?.workspaces?.find((item) => item?.id === ${quoted(state.setup.firstWorkspaceId)});
          return Boolean(workspace && !workspace.loading && route?.sessionsByWorkspaceId?.[${quoted(state.setup.firstWorkspaceId)}]?.length);
        })()`, { timeoutMs: 90_000, label: "benchmark route session index" });
        const indexedSessionIds = await ctx.eval(`(() => {
          const route = window.__openwork?.slice?.("route");
          return (route?.sessionsByWorkspaceId?.[${quoted(state.setup.firstWorkspaceId)}] || [])
            .map((session) => session?.id)
            .filter(Boolean);
        })()`);
        const indexedSessionIdSet = new Set(indexedSessionIds);
        const sampleSessions = firstWorkspace.sampleSessions;
        const switchSessions = [
          ...sampleSessions.filter((session) => !indexedSessionIdSet.has(session.sessionId)),
          ...sampleSessions.filter((session) => indexedSessionIdSet.has(session.sessionId)),
        ].slice(0, Math.min(10, sampleSessions.length)).map((session) => ({
          ...session,
          indexedBeforeOpen: indexedSessionIdSet.has(session.sessionId),
        }));
        const finalSwitchTitle = switchSessions[Math.min(9, switchSessions.length - 1)]?.title;
        await ctx.prove("Many real benchmark workspaces and sessions remain navigable in the visible app", {
          voiceover: vo[1],
          action: async () => {
            const params = readParams(ctx);
            const availableSessions = firstWorkspace.sampleSessions;
            recordAssertion(ctx, availableSessions.length > 0, "The first benchmark workspace has real sessions available for UI switching.", firstWorkspace);
            await installFetchProbe(ctx, "session-switches");
            await waitForWorkspaceRouteReady(ctx, state.setup.firstWorkspaceId);
            const routeReadyMs = state.activationRouteReadyMs;
            const eventLoopLag = await measureEventLoopLag(ctx);
            const switches = await measureSessionSwitches(ctx, state.setup.firstWorkspaceId, switchSessions);
            const fetchProbe = await fetchProbeSummary(ctx);
            state.perfAfterSetup = await getPerformanceMetrics(ctx, "after-setup-and-switches");
            const jsHeapUsedMiB = performanceMetricMiB(state.perfAfterSetup, "JSHeapUsedSize");
            state.ui = {
              routeReadyMs,
              eventLoopLag,
              switches,
              fetchProbe,
              jsHeapUsedMiB,
              routeIndexBeforeSwitches: {
                count: indexedSessionIds.length,
                outOfWindowSampleCount: switchSessions.filter((session) => !session.indexedBeforeOpen).length,
              },
              sidebarResizeGutter: await ctx.eval(`(() => {
                const rail = document.querySelector('[data-slot="sidebar-rail"]');
                const inset = document.querySelector('[data-slot="sidebar-inset"]');
                if (!(rail instanceof HTMLElement) || !(inset instanceof HTMLElement)) return null;
                const railRect = rail.getBoundingClientRect();
                const insetRect = inset.getBoundingClientRect();
                const mask = getComputedStyle(rail, '::before');
                const maskLeft = Number.parseFloat(mask.left);
                const maskRight = Number.parseFloat(mask.right);
                const overlapPx = Math.max(0, railRect.right - insetRect.left);
                return {
                  overlapPx,
                  maskBackground: mask.backgroundColor,
                  maskPointerEvents: mask.pointerEvents,
                  railPointerEvents: getComputedStyle(rail).pointerEvents,
                  maskCoversOverlap: Number.isFinite(maskLeft) && Number.isFinite(maskRight) &&
                    railRect.left + maskLeft <= insetRect.left + 0.5 &&
                    railRect.right - maskRight >= railRect.right - 0.5,
                };
              })()`),
              budgets: {
                maxRouteReadyMs: params.maxRouteReadyMs,
                maxSwitchP95Ms: params.maxSwitchP95Ms,
                maxEventLoopP95Ms: params.maxEventLoopP95Ms,
                maxEventAborts: params.maxEventAborts,
                maxJsHeapMb: params.maxJsHeapMb,
              },
              workspaceTotals: state.setup.workspaces.map((workspace) => ({
                id: workspace.id,
                benchmarkSessionCount: workspace.benchmarkSessionCount,
                createdBenchmarkSessions: workspace.createdBenchmarkSessions,
                existingBenchmarkSessions: workspace.existingBenchmarkSessions,
              })),
            };
            ctx.output("windows UI/session responsiveness metrics", JSON.stringify(state.ui, null, 2));
            ctx.output("cdp performance metrics after setup", JSON.stringify(state.perfAfterSetup.raw, null, 2));
            await dismissOpenWorkModelsPromo(ctx);
          },
          assert: async () => {
            const params = readParams(ctx);
            const available = state.setup.workspaces[0].benchmarkSessionCount;
            const expectedSwitches = Math.min(10, available);
            recordAssertion(ctx, state.ui.switches.count === expectedSwitches, "Visible session switches reached the requested min(10, available sessions) sample.", state.ui.switches);
            recordAssertion(ctx, state.ui.fetchProbe.summary.unexpectedErrors === 0, "Renderer fetch instrumentation saw no unexpected fetch failures during session switching.", state.ui.fetchProbe.summary);
            recordAssertion(ctx, Number.isInteger(state.ui.fetchProbe.summary.aborted) && state.ui.fetchProbe.summary.aborted <= params.maxEventAborts, "Renderer fetch instrumentation aborted request count stayed within OPENWORK_PERF_MAX_EVENT_ABORTS.", { actual: state.ui.fetchProbe.summary.aborted, budget: params.maxEventAborts, abortedByPath: state.ui.fetchProbe.summary.abortedByPath });
            recordAssertion(ctx, state.ui.eventLoopLag.samples > 0 && Number.isFinite(state.ui.eventLoopLag.max), "Renderer event-loop lag probe produced usable samples.", state.ui.eventLoopLag);
            recordAssertion(ctx, Number.isFinite(state.ui.routeReadyMs) && state.ui.routeReadyMs <= params.maxRouteReadyMs, "Workspace route readiness stayed within OPENWORK_PERF_MAX_ROUTE_READY_MS.", { actualMs: state.ui.routeReadyMs, budgetMs: params.maxRouteReadyMs });
            recordAssertion(ctx, state.ui.switches.latencyMs.p95 !== null && state.ui.switches.latencyMs.p95 <= params.maxSwitchP95Ms, "Visible session switch p95 stayed within OPENWORK_PERF_MAX_SWITCH_P95_MS.", { actualMs: state.ui.switches.latencyMs.p95, budgetMs: params.maxSwitchP95Ms, latencyMs: state.ui.switches.latencyMs });
            recordAssertion(ctx, state.ui.eventLoopLag.p95 !== null && state.ui.eventLoopLag.p95 <= params.maxEventLoopP95Ms, "Renderer event-loop lag p95 stayed within OPENWORK_PERF_MAX_EVENT_LOOP_P95_MS.", { actualMs: state.ui.eventLoopLag.p95, budgetMs: params.maxEventLoopP95Ms, eventLoopLag: state.ui.eventLoopLag });
            recordAssertion(ctx, Number.isFinite(state.ui.jsHeapUsedMiB) && state.ui.jsHeapUsedMiB <= params.maxJsHeapMb, "After-setup renderer JS heap stayed within OPENWORK_PERF_MAX_JS_HEAP_MB.", { actualMiB: state.ui.jsHeapUsedMiB, budgetMiB: params.maxJsHeapMb, metric: "JSHeapUsedSize" });
            recordAssertion(ctx, state.ui.sidebarResizeGutter?.overlapPx > 0 && state.ui.sidebarResizeGutter.maskCoversOverlap === true && state.ui.sidebarResizeGutter.maskBackground !== "rgba(0, 0, 0, 0)" && state.ui.sidebarResizeGutter.maskPointerEvents === "none" && state.ui.sidebarResizeGutter.railPointerEvents !== "none", "The sidebar resize gutter paints over its main-pane overlap without blocking resize input.", state.ui.sidebarResizeGutter);
            recordAssertion(ctx, state.ui.switches.records.every((record) => record.readiness?.activeTabTitle === record.title && record.readiness?.headerTitle === record.title && record.readiness?.routeSessionTitle === record.title), "Every switched session keeps its route state, header, and active-tab title aligned.", state.ui.switches.records);
            recordAssertion(ctx, !params.requireOutOfWindowSession || state.ui.switches.records.some((record) => record.indexedBeforeOpen === false), "The dedicated regression configuration explicitly exercises an out-of-window routed session.", { required: params.requireOutOfWindowSession, totalListedSessions: firstWorkspace.totalListedSessions, routeIndexBeforeSwitches: state.ui.routeIndexBeforeSwitches, records: state.ui.switches.records });
            await ctx.expectHashIncludes(`/workspace/${state.setup.firstWorkspaceId}/session`);
          },
          screenshot: {
            name: "benchmark-sessions-navigable",
            requireText: ["Search sessions", finalSwitchTitle],
            rejectText: ["Something went wrong", "Use OpenWork Models without API keys"],
          },
        });
      },
    },
    {
      name: "Frame 3 - concurrent real model conversations",
      run: async (ctx) => {
        const params = readParams(ctx);
        await startRendererJob(ctx, "conversations", {
          flowId: FLOW_ID,
          runId: params.runId,
          safeRunId: params.safeRunId,
          timeoutMs: params.timeoutMs,
          conversations: params.conversations,
          concurrency: params.concurrency,
          provider: params.provider,
          model: params.model,
          workspaceId: state.setup.firstWorkspaceId,
        }, conversationWorker);
        state.conversations = await pollRendererJob(ctx, "conversations", params.timeoutMs + 30_000);
        state.perfAfterConversations = await getPerformanceMetrics(ctx, "after-conversations");
        ctx.output("windows conversation metrics", JSON.stringify(state.conversations, null, 2));
        ctx.output("cdp performance metrics after conversations", JSON.stringify(state.perfAfterConversations.raw, null, 2));
        await ctx.prove("Concurrent real model conversations complete in isolated sessions without marker leakage", {
          voiceover: vo[2],
          action: async () => {
            const representative = state.conversations.representative;
            recordAssertion(ctx, Boolean(representative?.sessionId && representative.marker), "A successful representative conversation is available for the final screenshot.", representative);
            await ctx.control("session.open", { sessionId: representative.sessionId });
            await waitForWorkspaceRouteReady(ctx, state.setup.firstWorkspaceId, representative.sessionId);
            await dismissOpenWorkModelsPromo(ctx);
            await ctx.waitForText(representative.marker, { timeoutMs: 90_000 });
          },
          assert: async () => {
            const params = readParams(ctx);
            recordAssertion(ctx, state.conversations.provider && state.conversations.model, "A connected/default provider and model were detected from the real provider response.", { provider: state.conversations.provider, model: state.conversations.model, source: state.conversations.modelSource });
            recordAssertion(ctx, state.conversations.successCount === params.conversations, "Every requested real conversation completed successfully.", { requested: params.conversations, success: state.conversations.successCount, failures: state.conversations.items.filter((item) => !item.success) });
            recordAssertion(ctx, state.conversations.failureCount === 0 && state.conversations.timeoutCount === 0, "Conversations had zero failures, zero timeouts, and no cross-session marker leakage.", { failureCount: state.conversations.failureCount, timeoutCount: state.conversations.timeoutCount });
            recordAssertion(ctx, state.conversations.requestSummary.errors === 0, "Conversation setup, prompt acceptance, status polling, and message reads had zero API failures.", state.conversations.requestSummary);
            const allSuccessItems = state.conversations.items.every((item) => item.success && item.sawAssistant && item.finalStatus === "idle");
            recordAssertion(ctx, allSuccessItems, "Every successful conversation saw assistant output and reached idle status.", state.conversations.items);
          },
          screenshot: {
            name: "completed-assistant-marker",
            requireText: [state.conversations.representative.marker],
            rejectText: ["Something went wrong", "Use OpenWork Models without API keys"],
          },
        });
      },
    },
  ],
};
