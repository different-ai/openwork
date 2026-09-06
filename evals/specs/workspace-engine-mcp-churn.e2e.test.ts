import { spawn } from "node:child_process";
import { expect } from "vitest";
import { control, evalIn, go, waitFor } from "@openwork/behaviors";
import {
  app,
  eventually,
  mcpMock,
  needs,
  server,
  test,
  unmetNeeds,
} from "@openwork/testkit";
import type { App, MockHandle, TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
  placement: "daytona",
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `workspace engine and MCP churn skipped — needs: ${missingRequirements.join(", ")}`
  : "workspace routing bounds in-place engine disposal and MCP reconnect churn";
const setupQuietWindowMs = 12_000;
const setupConvergenceTimeoutMs = 120_000;
const daytonaLogTailBytes = 256 * 1024;
const engineLogFactLimit = 80;

interface WorkspaceListing {
  ids: string[];
  activeId: string | null;
}

interface ActivationFact {
  id: string;
  workspaceId: string;
  timestamp: number;
}

interface DisposeFact {
  workspaceId: string;
  type: string;
  directory: string | null;
  at: number;
}

interface LifecycleProbe {
  disposes: DisposeFact[];
  eventConnections: number;
}

interface EngineGenerationFact {
  role: string;
  pid: number | null;
  port: number | null;
  spawnedAt: number | null;
}

interface EngineRuntimeFact {
  observedAt: number;
  lifecycleState: string;
  enginePid: number | null;
  engineRollover: boolean;
  generations: EngineGenerationFact[];
}

interface McpRpcCounts {
  initialize: number;
  toolsList: number;
}

interface McpRpcFact {
  requestId: number | null;
  method: "initialize" | "tools/list";
  at: string;
  atMs: number | null;
}

interface McpRpcSnapshot extends McpRpcCounts {
  facts: McpRpcFact[];
}

interface CloudProviderSyncFact {
  hasSession: boolean;
  reloadPending: boolean;
  lastRunStatus: string;
  lastRunAt: string;
  lastRunMessage: string;
  lastRunDetail: Record<string, unknown> | null;
}

interface ReloadEventFact {
  id: string;
  seq: number;
  workspaceId: string;
  reason: string;
  timestamp: number;
  trigger: Record<string, unknown> | null;
}

interface ReloadEventSnapshot {
  cursor: number;
  items: ReloadEventFact[];
}

interface DaytonaLogTail {
  sandboxId: string;
  logPath: string;
  capturedAt: number;
  raw: string;
}

interface EngineLogFact {
  source: "structured" | "plain";
  timestamp: string;
  severity: string;
  message: string;
  body: string;
  attributes: Record<string, unknown>;
  raw: string;
}

interface QuietTransition {
  at: number;
  sync: CloudProviderSyncFact;
  runtime: EngineRuntimeFact;
  mcp: McpRpcCounts;
  disposes: number;
}

interface SetupConvergence {
  converged: boolean;
  quietForMs: number;
  settledAt: number;
  sync: CloudProviderSyncFact;
  runtime: EngineRuntimeFact;
  mcp: McpRpcSnapshot;
  probe: LifecycleProbe;
  transitions: QuietTransition[];
  error: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function boundedText(value: string, maximum = 1_200): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

function appendBoundedTail(current: string, chunk: string, maximum: number): string {
  const combined = `${current}${chunk}`;
  return combined.length <= maximum ? combined : combined.slice(-maximum);
}

function logText(value: unknown): string {
  if (typeof value === "string") return boundedText(value);
  if (value === undefined || value === null) return "";
  const encoded = JSON.stringify(value);
  return boundedText(typeof encoded === "string" ? encoded : String(value));
}

function boundedLogAttribute(value: unknown): unknown {
  if (typeof value === "string") return boundedText(value, 600);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 10).map(boundedLogAttribute);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, entry]) => [key, boundedLogAttribute(entry)]));
  }
  return boundedText(String(value), 600);
}

function diagnosticLogAttributes(
  root: Record<string, unknown>,
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  const selected = new Map<string, unknown>();
  const relevantKeys = new Set([
    "workspace.id",
    "method",
    "path",
    "status",
    "durationMs",
    "proxy.base_url",
    "proxy.service",
    "error",
    "error.code",
    "error.path",
    "error.cause",
  ]);
  for (const source of [root, attributes]) {
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith("engine.") || relevantKeys.has(key)) selected.set(key, boundedLogAttribute(value));
    }
  }
  return Object.fromEntries(selected);
}

const engineLifecycleLogPattern = /(?:engine[^\n]*(?:rollover|recover|reload|dispose|failure)|(?:rollover|recover|reload|dispose)[^\n]*engine|\/instance\/dispose|opencode_(?:engine_unreachable|reload_(?:failed|timeout))|(?:request|connection)[^\n]*(?:fail|refused|reset|timeout)|(?:ECONNREFUSED|ECONNRESET|UND_ERR|fetch failed))/i;
const failedOpencodeRequestPattern = /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\S*(?:opencode|engine)\S*\s+5\d\d\b/i;

function parseStructuredLogLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  const candidates = [trimmed];
  const openingBrace = trimmed.indexOf("{");
  if (openingBrace > 0) candidates.push(trimmed.slice(openingBrace));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Electron also emits unstructured child-process lines into this log.
    }
  }
  return null;
}

function parseEngineLogFacts(text: string): EngineLogFact[] {
  return text.split(/\r?\n/).flatMap<EngineLogFact>((line) => {
    if (!line.trim()) return [];
    const structured = parseStructuredLogLine(line);
    if (!structured) {
      if (!engineLifecycleLogPattern.test(line) && !failedOpencodeRequestPattern.test(line)) return [];
      return [{
        source: "plain",
        timestamp: "",
        severity: "",
        message: boundedText(line),
        body: boundedText(line),
        attributes: {},
        raw: boundedText(line),
      }];
    }
    const attributes = isRecord(structured.attributes) ? structured.attributes : {};
    const message = logText(structured.message ?? structured.msg);
    const body = logText(structured.body);
    const selectedAttributes = diagnosticLogAttributes(structured, attributes);
    const status = typeof attributes.status === "number" ? attributes.status : null;
    const proxyService = typeof attributes["proxy.service"] === "string" ? attributes["proxy.service"] : "";
    const searchable = `${message}\n${body}\n${JSON.stringify(selectedAttributes)}\n${line}`;
    const relevant = Object.keys(selectedAttributes).some((key) => key.startsWith("engine."))
      || engineLifecycleLogPattern.test(searchable)
      || failedOpencodeRequestPattern.test(searchable)
      || (status !== null && status >= 500 && proxyService === "opencode");
    if (!relevant) return [];
    return [{
      source: "structured",
      timestamp: typeof structured.timeUnixNano === "string"
        ? structured.timeUnixNano
        : typeof structured.timestamp === "string"
          ? structured.timestamp
          : "",
      severity: typeof structured.severityText === "string"
        ? structured.severityText
        : typeof structured.level === "string"
          ? structured.level
          : "",
      message: boundedText(message),
      body: boundedText(body),
      attributes: selectedAttributes,
      raw: boundedText(line),
    }];
  }).slice(-engineLogFactLimit);
}

function engineLogSignalCounts(facts: EngineLogFact[]): Record<string, number> {
  const text = (fact: EngineLogFact) => `${fact.message}\n${fact.body}\n${JSON.stringify(fact.attributes)}\n${fact.raw}`;
  return {
    rollover: facts.filter((fact) => /rollover/i.test(text(fact))).length,
    recovery: facts.filter((fact) => /recover/i.test(text(fact))).length,
    reload: facts.filter((fact) => /reload/i.test(text(fact))).length,
    dispose: facts.filter((fact) => /dispos/i.test(text(fact))).length,
    requestFailure: facts.filter((fact) => {
      const status = fact.attributes.status;
      const proxyService = fact.attributes["proxy.service"];
      return (typeof status === "number" && status >= 500 && proxyService === "opencode")
        || /(?:request|connection)[^\n]*(?:fail|refused|reset|timeout)|ECONNREFUSED|ECONNRESET|UND_ERR|fetch failed/i.test(text(fact));
    }).length,
  };
}

function tailDelta(before: string, after: string): { overlap: boolean; text: string } {
  if (!before) return { overlap: true, text: after };
  if (after.startsWith(before)) return { overlap: true, text: after.slice(before.length) };
  const anchor = before.slice(-4_096);
  const anchorAt = anchor ? after.lastIndexOf(anchor) : -1;
  if (anchorAt >= 0) return { overlap: true, text: after.slice(anchorAt + anchor.length) };
  const lastLine = before.trimEnd().split(/\r?\n/).at(-1) ?? "";
  const lastLineAt = lastLine ? after.lastIndexOf(lastLine) : -1;
  return lastLineAt >= 0
    ? { overlap: true, text: after.slice(lastLineAt + lastLine.length) }
    : { overlap: false, text: after };
}

async function readDaytonaLogTail(desktopApp: App): Promise<DaytonaLogTail> {
  const sandboxId = desktopApp.handle.sandboxId?.trim() ?? "";
  const logPath = desktopApp.handle.meta?.log?.trim() ?? "";
  if (!sandboxId || !logPath) {
    throw new Error(`Daytona Electron log metadata is unavailable: ${JSON.stringify(desktopApp.handle)}`);
  }
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      "daytona",
      ["exec", sandboxId, "--", "tail", "-c", String(daytonaLogTailBytes), logPath],
      { shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = globalThis.setTimeout(() => child.kill("SIGTERM"), 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = appendBoundedTail(stdout, String(chunk), daytonaLogTailBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBoundedTail(stderr, String(chunk), 32_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
  if (result.code !== 0) {
    throw new Error(`Daytona Electron log tail failed with exit ${result.code}: ${result.stderr.trim()}`);
  }
  return { sandboxId, logPath, capturedAt: Date.now(), raw: result.stdout };
}

function parseLifecycleProbe(value: unknown): LifecycleProbe {
  if (!isRecord(value)) throw new Error(`Invalid workspace churn probe: ${JSON.stringify(value)}`);
  return {
    disposes: records(value.disposes).map((entry) => ({
      workspaceId: typeof entry.workspaceId === "string" ? entry.workspaceId : "",
      type: typeof entry.type === "string" ? entry.type : "",
      directory: typeof entry.directory === "string" ? entry.directory : null,
      at: typeof entry.at === "number" ? entry.at : 0,
    })),
    eventConnections: typeof value.eventConnections === "number" ? value.eventConnections : 0,
  };
}

function parseActivationFacts(value: unknown): ActivationFact[] {
  if (!Array.isArray(value)) throw new Error(`Invalid workspace activation facts: ${JSON.stringify(value)}`);
  return value.flatMap((entry) =>
    isRecord(entry)
      && typeof entry.id === "string"
      && typeof entry.workspaceId === "string"
      && typeof entry.timestamp === "number"
      ? [{ id: entry.id, workspaceId: entry.workspaceId, timestamp: entry.timestamp }]
      : []);
}

function parseEngineRuntime(value: unknown): EngineRuntimeFact {
  const root = isRecord(value) ? value : {};
  const engine = isRecord(root.engine) ? root.engine : {};
  const openworkServer = isRecord(root.openworkServer) ? root.openworkServer : {};
  const pool = isRecord(root.enginePool) ? root.enginePool : {};
  return {
    observedAt: Date.now(),
    lifecycleState: typeof root.lifecycleState === "string" ? root.lifecycleState : "",
    enginePid: typeof engine.pid === "number" ? engine.pid : null,
    engineRollover: openworkServer.engineRollover === true,
    generations: records(pool.generations).flatMap((generation) =>
      typeof generation.role === "string"
        ? [{
            role: generation.role,
            pid: typeof generation.pid === "number" ? generation.pid : null,
            port: typeof generation.port === "number" ? generation.port : null,
            spawnedAt: typeof generation.spawnedAt === "number" ? generation.spawnedAt : null,
          }]
        : []),
  };
}

function runtimeIdentity(value: EngineRuntimeFact): string {
  return JSON.stringify({
    enginePid: value.enginePid,
    engineRollover: value.engineRollover,
    generations: [...value.generations]
      .sort((left, right) => (left.pid ?? 0) - (right.pid ?? 0))
      .map(({ role, pid, port, spawnedAt }) => ({ role, pid, port, spawnedAt })),
  });
}

function runtimeStayedOn(
  baseline: EngineRuntimeFact,
  observations: EngineRuntimeFact[],
): boolean {
  const expected = runtimeIdentity(baseline);
  return observations.every((observation) => runtimeIdentity(observation) === expected);
}

function countByWorkspace(facts: Array<{ workspaceId: string }>): Record<string, number> {
  return facts.reduce<Record<string, number>>((counts, fact) => {
    counts[fact.workspaceId] = (counts[fact.workspaceId] ?? 0) + 1;
    return counts;
  }, {});
}

function mcpDelta(before: McpRpcCounts, after: McpRpcCounts): McpRpcCounts {
  return {
    initialize: after.initialize - before.initialize,
    toolsList: after.toolsList - before.toolsList,
  };
}

function mcpFactsDelta(before: McpRpcSnapshot, after: McpRpcSnapshot): McpRpcFact[] {
  return after.facts.slice(before.facts.length);
}

async function listWorkspaces(desktopApp: App): Promise<WorkspaceListing> {
  const value = await evalIn(desktopApp, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { error: "local_server_unavailable" };
    const response = await fetch(String(info.baseUrl).replace(/\\/+$/, "") + "/workspaces", {
      headers: { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") },
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    const items = Array.isArray(body?.items) ? body.items : [];
    return {
      ok: response.ok,
      ids: items.map((item) => String(item?.id ?? "")).filter(Boolean),
      activeId: typeof body?.activeId === "string" ? body.activeId : null,
    };
  })()`, { awaitPromise: true, timeoutMs: 20_000 });
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.ids)) {
    throw new Error(`Listing workspaces failed: ${JSON.stringify(value)}`);
  }
  return {
    ids: value.ids.filter((id): id is string => typeof id === "string"),
    activeId: typeof value.activeId === "string" ? value.activeId : null,
  };
}

async function createWorkspace(desktopApp: App, path: string): Promise<string> {
  const before = await listWorkspaces(desktopApp);
  await control(desktopApp, "workspace.create", { path }, { timeoutMs: 90_000 });
  const after = await eventually(() => listWorkspaces(desktopApp), {
    within: 90_000,
    intervalMs: 500,
    label: `workspace ${path} registered`,
    until: (listing) => listing.ids.length === before.ids.length + 1,
  });
  const created = after.ids.find((id) => !before.ids.includes(id));
  if (!created) throw new Error(`workspace.create produced no new id for ${path}.`);
  return created;
}

async function waitForWorkspaceRoute(desktopApp: App, workspaceId: string): Promise<WorkspaceListing> {
  await waitFor(desktopApp, `(() => {
    const route = window.__openworkControl?.snapshot().route ?? window.location.hash;
    return route.includes(${JSON.stringify(`/workspace/${workspaceId}/`)})
      && (localStorage.getItem("openwork.react.activeWorkspace") ?? "") === ${JSON.stringify(workspaceId)};
  })()`, { timeoutMs: 60_000, label: `route and local selection adopt ${workspaceId}` });
  return eventually(() => listWorkspaces(desktopApp), {
    within: 60_000,
    intervalMs: 250,
    label: `local server adopts workspace ${workspaceId}`,
    until: (listing) => listing.activeId === workspaceId,
  });
}

/** Server audit entries are the durable authority that an activation was admitted. */
async function readActivationFacts(desktopApp: App, workspaceIds: string[]): Promise<ActivationFact[]> {
  const value = await evalIn(desktopApp, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { error: "local_server_unavailable" };
    const root = String(info.baseUrl).replace(/\\/+$/, "");
    const headers = { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") };
    const activations = [];
    for (const workspaceId of ${JSON.stringify(workspaceIds)}) {
      const response = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/audit?limit=200", {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) return { error: "audit_http_" + response.status, workspaceId };
      const body = await response.json();
      for (const entry of Array.isArray(body?.items) ? body.items : []) {
        if (entry?.action === "workspace.activate") activations.push({
          id: String(entry.id ?? ""),
          workspaceId: String(entry.workspaceId ?? workspaceId),
          timestamp: Number(entry.timestamp ?? 0),
        });
      }
    }
    return activations.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
  })()`, { awaitPromise: true, timeoutMs: 40_000 });
  return parseActivationFacts(value);
}

async function addMcpWitnesses(
  desktopApp: App,
  workspaces: Array<{ id: string; name: string }>,
  mcpUrl: string,
): Promise<void> {
  const result = await evalIn(desktopApp, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { error: "local_server_unavailable" };
    const root = String(info.baseUrl).replace(/\\/+$/, "");
    const headers = {
      Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? ""),
      "Content-Type": "application/json",
    };
    const outcomes = [];
    for (const workspace of ${JSON.stringify(workspaces)}) {
      const response = await fetch(root + "/workspace/" + encodeURIComponent(workspace.id) + "/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: workspace.name,
          config: { type: "remote", url: ${JSON.stringify(mcpUrl)}, enabled: true, oauth: false },
        }),
        signal: AbortSignal.timeout(30000),
      });
      outcomes.push({ workspaceId: workspace.id, status: response.status, body: (await response.text()).slice(0, 300) });
    }
    return { outcomes };
  })()`, { awaitPromise: true, timeoutMs: 90_000 });
  if (!isRecord(result) || !Array.isArray(result.outcomes)) {
    throw new Error(`Adding MCP witnesses failed: ${JSON.stringify(result)}`);
  }
  const failures = result.outcomes.filter((outcome) =>
    !isRecord(outcome) || typeof outcome.status !== "number" || outcome.status < 200 || outcome.status >= 300);
  if (failures.length > 0) throw new Error(`Adding MCP witnesses returned failures: ${JSON.stringify(failures)}`);
}

/** These setup-only reads force both directory-scoped MCP registrations to be observable before measurement. */
async function primeMcpWitnesses(desktopApp: App, workspaceIds: string[]): Promise<void> {
  const result = await evalIn(desktopApp, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { error: "local_server_unavailable" };
    const root = String(info.baseUrl).replace(/\\/+$/, "");
    const headers = { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") };
    const outcomes = [];
    for (const workspaceId of ${JSON.stringify(workspaceIds)}) {
      const response = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/opencode/mcp", {
        headers,
        signal: AbortSignal.timeout(30000),
      });
      outcomes.push({ workspaceId, status: response.status });
    }
    return { outcomes };
  })()`, { awaitPromise: true, timeoutMs: 90_000 });
  if (!isRecord(result) || !Array.isArray(result.outcomes)) {
    throw new Error(`Priming MCP witnesses failed: ${JSON.stringify(result)}`);
  }
  const failures = result.outcomes.filter((outcome) => !isRecord(outcome) || outcome.status !== 200);
  if (failures.length > 0) throw new Error(`MCP setup probes returned failures: ${JSON.stringify(failures)}`);
}

async function readMcpRpcCounts(mock: MockHandle): Promise<McpRpcSnapshot> {
  const response = await fetch(`${mock.url}/requests`, { signal: AbortSignal.timeout(15_000) });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(value) || !Array.isArray(value.requests)) {
    throw new Error(`Mock MCP request log failed: HTTP ${response.status} ${JSON.stringify(value).slice(0, 500)}`);
  }
  const facts = value.requests.flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.rpcMethods)) return [];
    const at = typeof entry.at === "string" ? entry.at : "";
    const parsedAt = Date.parse(at);
    const requestId = typeof entry.id === "number" ? entry.id : null;
    return entry.rpcMethods.flatMap((method) =>
      method === "initialize" || method === "tools/list"
        ? [{ requestId, method, at, atMs: Number.isFinite(parsedAt) ? parsedAt : null }]
        : []);
  });
  return {
    initialize: facts.filter((fact) => fact.method === "initialize").length,
    toolsList: facts.filter((fact) => fact.method === "tools/list").length,
    facts,
  };
}

async function waitForMcpSettled(
  mock: MockHandle,
  minimum: McpRpcCounts,
): Promise<{ counts: McpRpcSnapshot; reachedMinimum: boolean }> {
  let previous = "";
  let stableSamples = 0;
  try {
    const result = await eventually(async () => {
      const counts = await readMcpRpcCounts(mock);
      const key = JSON.stringify(counts);
      stableSamples = key === previous ? stableSamples + 1 : 0;
      previous = key;
      return { counts, stableSamples };
    }, {
      within: 30_000,
      intervalMs: 1_000,
      label: `MCP log settles at initialize>=${minimum.initialize}, tools/list>=${minimum.toolsList}`,
      until: (sample) => sample.counts.initialize >= minimum.initialize
        && sample.counts.toolsList >= minimum.toolsList
        && sample.stableSamples >= 2,
    });
    return { counts: result.counts, reachedMinimum: true };
  } catch {
    return { counts: await readMcpRpcCounts(mock), reachedMinimum: false };
  }
}

async function installLifecycleProbe(
  desktopApp: App,
  workspaces: Array<{ id: string; path: string }>,
): Promise<void> {
  const result = await evalIn(desktopApp, `(() => {
    const originalFetch = window.fetch.bind(window);
    const workspaces = ${JSON.stringify(workspaces)};
    const probe = { active: true, disposes: [], eventConnections: 0 };
    window.__owWorkspaceEngineMcpChurn = probe;
    (async () => {
      const anchorWorkspaceId = workspaces[0]?.id ?? "";
      while (probe.active) {
        try {
          const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
          const root = String(info?.baseUrl ?? "").replace(/\\/+$/, "");
          const token = String(info?.ownerToken ?? info?.clientToken ?? "");
          const url = root + "/workspace/" + encodeURIComponent(anchorWorkspaceId) + "/opencode/global/event";
          const response = await originalFetch(url, { headers: { Authorization: "Bearer " + token } });
          if (!response.ok || !response.body) throw new Error("global event stream HTTP " + response.status);
          probe.eventConnections += 1;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (probe.active) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const frames = buffer.split("\\n\\n");
            buffer = frames.pop() ?? "";
            for (const frame of frames) for (const line of frame.split("\\n")) {
              if (!line.startsWith("data:")) continue;
              try {
                const event = JSON.parse(line.slice(5).trim());
                const type = String(event?.type ?? event?.payload?.type ?? "unknown");
                const properties = event?.properties ?? event?.payload?.properties ?? {};
                if (type.includes("disposed")) {
                  const directory = typeof event?.directory === "string"
                    ? event.directory
                    : typeof event?.payload?.directory === "string"
                      ? event.payload.directory
                      : typeof properties?.directory === "string"
                        ? properties.directory
                        : null;
                  const workspace = workspaces.find((candidate) => candidate.path === directory);
                  probe.disposes.push({
                    workspaceId: workspace?.id ?? "",
                    type,
                    directory,
                    at: Date.now(),
                  });
                }
              } catch {}
            }
          }
        } catch {}
        if (probe.active) await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
    })();
    return "ok";
  })()`);
  expect(result).toBe("ok");
  await eventually(() => readLifecycleProbe(desktopApp), {
    within: 30_000,
    intervalMs: 250,
    label: "global engine event stream connected",
    until: (probe) => probe.eventConnections >= 1,
  });
}

async function readLifecycleProbe(desktopApp: App): Promise<LifecycleProbe> {
  return parseLifecycleProbe(await evalIn(desktopApp, `(() => {
    const probe = window.__owWorkspaceEngineMcpChurn;
    return probe ? JSON.parse(JSON.stringify(probe)) : null;
  })()`));
}

async function readEngineRuntime(desktopApp: App): Promise<EngineRuntimeFact> {
  return parseEngineRuntime(await evalIn(
    desktopApp,
    `window.__OPENWORK_ELECTRON__.invokeDesktop("runtimeStatus")`,
    { awaitPromise: true, timeoutMs: 15_000 },
  ));
}

async function readCloudProviderSync(desktopApp: App): Promise<CloudProviderSyncFact> {
  const value = await evalIn(desktopApp, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { error: "local_server_unavailable" };
    const response = await fetch(String(info.baseUrl).replace(/\\/+$/, "") + "/cloud-provider-sync/status", {
      headers: { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { error: "cloud_provider_sync_http_" + response.status };
    return response.json();
  })()`, { awaitPromise: true, timeoutMs: 20_000 });
  if (!isRecord(value) || typeof value.reloadPending !== "boolean") {
    throw new Error(`Invalid CloudProviderSync status: ${JSON.stringify(value)}`);
  }
  const lastRun = isRecord(value.lastRun) ? value.lastRun : {};
  return {
    hasSession: value.hasSession === true,
    reloadPending: value.reloadPending,
    lastRunStatus: typeof lastRun.status === "string" ? lastRun.status : "none",
    lastRunAt: typeof lastRun.at === "string" ? lastRun.at : "",
    lastRunMessage: typeof lastRun.message === "string" ? lastRun.message : "",
    lastRunDetail: isRecord(lastRun.detail) ? lastRun.detail : null,
  };
}

function parseReloadEventSnapshot(value: unknown): ReloadEventSnapshot {
  if (!isRecord(value) || typeof value.cursor !== "number" || !Array.isArray(value.items)) {
    throw new Error(`Invalid reload-event snapshot: ${JSON.stringify(value)}`);
  }
  return {
    cursor: value.cursor,
    items: value.items.flatMap((entry) => {
      if (!isRecord(entry)
        || typeof entry.id !== "string"
        || typeof entry.seq !== "number"
        || typeof entry.workspaceId !== "string"
        || typeof entry.reason !== "string"
        || typeof entry.timestamp !== "number") return [];
      return [{
        id: entry.id,
        seq: entry.seq,
        workspaceId: entry.workspaceId,
        reason: entry.reason,
        timestamp: entry.timestamp,
        trigger: isRecord(entry.trigger) ? entry.trigger : null,
      }];
    }),
  };
}

async function readReloadEvents(
  desktopApp: App,
  workspaceIds: string[],
  since?: number,
): Promise<ReloadEventSnapshot> {
  const value = await evalIn(desktopApp, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { error: "local_server_unavailable" };
    const root = String(info.baseUrl).replace(/\\/+$/, "");
    const headers = { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") };
    const since = ${typeof since === "number" ? String(since) : "null"};
    const items = [];
    let cursor = 0;
    for (const workspaceId of ${JSON.stringify(workspaceIds)}) {
      const query = typeof since === "number" ? "?since=" + encodeURIComponent(String(since)) : "";
      const response = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/events" + query, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) return { error: "reload_events_http_" + response.status, workspaceId };
      const body = await response.json();
      cursor = Math.max(cursor, Number(body?.cursor ?? 0));
      for (const event of Array.isArray(body?.items) ? body.items : []) items.push(event);
    }
    items.sort((left, right) => Number(left?.seq ?? 0) - Number(right?.seq ?? 0));
    return { cursor, items };
  })()`, { awaitPromise: true, timeoutMs: 40_000 });
  return parseReloadEventSnapshot(value);
}

async function waitForSetupConvergence(desktopApp: App, mock: MockHandle): Promise<SetupConvergence> {
  let stableKey = "";
  let transitionKey = "";
  let quietSince = 0;
  let latest: Omit<SetupConvergence, "converged" | "transitions" | "error"> | null = null;
  const transitions: QuietTransition[] = [];
  const sample = async () => {
    const [sync, runtime, mcp, probe] = await Promise.all([
      readCloudProviderSync(desktopApp),
      readEngineRuntime(desktopApp),
      readMcpRpcCounts(mock),
      readLifecycleProbe(desktopApp),
    ]);
    const at = Date.now();
    const engineQuiet = runtime.lifecycleState === "healthy"
      && runtime.enginePid !== null
      && runtime.generations.length === 1
      && runtime.generations[0]?.role === "primary"
      && runtime.generations[0]?.pid === runtime.enginePid;
    const syncQuiet = sync.hasSession
      && sync.reloadPending === false
      && (sync.lastRunStatus === "applied" || sync.lastRunStatus === "noop");
    const eligible = syncQuiet && engineQuiet;
    const key = JSON.stringify({
      sync,
      runtime: runtimeIdentity(runtime),
      mcp: { initialize: mcp.initialize, toolsList: mcp.toolsList },
      disposes: probe.disposes.length,
    });
    if (!eligible) {
      stableKey = "";
      quietSince = 0;
    } else if (key !== stableKey) {
      stableKey = key;
      quietSince = at;
    }
    const quietForMs = quietSince === 0 ? 0 : at - quietSince;
    const nextTransitionKey = JSON.stringify({ eligible, key });
    if (nextTransitionKey !== transitionKey) {
      transitionKey = nextTransitionKey;
      transitions.push({
        at,
        sync,
        runtime,
        mcp: { initialize: mcp.initialize, toolsList: mcp.toolsList },
        disposes: probe.disposes.length,
      });
    }
    latest = { quietForMs, settledAt: at, sync, runtime, mcp, probe };
    return latest;
  };
  try {
    const settled = await eventually(sample, {
      within: setupConvergenceTimeoutMs,
      intervalMs: 1_000,
      label: `${setupQuietWindowMs}ms setup engine/MCP quiet window with CloudProviderSync reloadPending=false`,
      until: (state) => state.quietForMs >= setupQuietWindowMs,
    });
    return { ...settled, converged: true, transitions, error: "" };
  } catch (error) {
    const settled = latest ?? await sample();
    return {
      ...settled,
      converged: false,
      transitions,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function switchAndWaitForAdmission(
  desktopApp: App,
  workspaceIds: string[],
  workspaceId: string,
  minimumActivationCount: number,
): Promise<EngineRuntimeFact> {
  await go(desktopApp, `/workspace/${workspaceId}/session`);
  await waitFor(desktopApp, `(() => {
    const route = window.__openworkControl?.snapshot().route ?? window.location.hash;
    return route.includes(${JSON.stringify(`/workspace/${workspaceId}/`)})
      && (localStorage.getItem("openwork.react.activeWorkspace") ?? "") === ${JSON.stringify(workspaceId)};
  })()`, { timeoutMs: 60_000, label: `route selects ${workspaceId}` });
  await eventually(() => readActivationFacts(desktopApp, workspaceIds), {
    within: 60_000,
    intervalMs: 250,
    label: `activation audit admits ${workspaceId}`,
    until: (activations) => activations.length >= minimumActivationCount
      && activations.at(-1)?.workspaceId === workspaceId,
  });
  const listing = await waitForWorkspaceRoute(desktopApp, workspaceId);
  expect(listing.activeId).toBe(workspaceId);
  return readEngineRuntime(desktopApp);
}

async function runZeroDwellBurst(desktopApp: App, workspaceIds: string[]): Promise<void> {
  const finalHash = await evalIn(desktopApp, `(async () => {
    for (const workspaceId of ${JSON.stringify(workspaceIds)}) {
      window.location.hash = "#/workspace/" + encodeURIComponent(workspaceId) + "/session";
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    return window.location.hash;
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  expect(String(finalHash)).toContain(`/workspace/${workspaceIds.at(-1)}/session`);
}

test.skipIf(missingRequirements.length > 0)(title, { timeout: 15 * 60_000 }, async ({ evidence, place }) => {
  needs(requirements);
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  await using den = await server({
    place,
    mocks: { witness: mcpMock({ allowUnauthenticatedMcp: true }) },
    org: {
      name: "Workspace Engine MCP Churn",
      admin: { name: "Churn Admin" },
    },
  });
  const workspaceAPath = `/tmp/openwork-workspace-churn-${runId}-a`;
  const workspaceBPath = `/tmp/openwork-workspace-churn-${runId}-b`;
  await using desktopApp = await app({ den, as: "admin", place, workspacePath: workspaceAPath });

  const workspaceA = desktopApp.workspaceId;
  const workspaceB = await createWorkspace(desktopApp, workspaceBPath);
  const workspaceIds = [workspaceA, workspaceB];
  const workspaces = [
    { id: workspaceA, path: workspaceAPath },
    { id: workspaceB, path: workspaceBPath },
  ];
  await addMcpWitnesses(desktopApp, [
    { id: workspaceA, name: "workspace-churn-a" },
    { id: workspaceB, name: "workspace-churn-b" },
  ], den.mocks.witness.mcpUrl);
  // One global stream observes both directories. Attribution comes from the
  // event's own directory, avoiding duplicate counting from two scoped streams.
  await installLifecycleProbe(desktopApp, workspaces);

  // Setup and all MCP status probes finish before the first measured baseline.
  // Distinct per-workspace MCP names also make the engine config fingerprints
  // differ, so a changed activation exercises the real reload path.
  await go(desktopApp, `/workspace/${workspaceB}/session`);
  await waitForWorkspaceRoute(desktopApp, workspaceB);
  await go(desktopApp, `/workspace/${workspaceA}/session`);
  await waitForWorkspaceRoute(desktopApp, workspaceA);
  await primeMcpWitnesses(desktopApp, workspaceIds);
  const setupMcp = await waitForMcpSettled(den.mocks.witness, { initialize: 2, toolsList: 2 });
  expect(setupMcp.reachedMinimum, JSON.stringify(setupMcp)).toBe(true);
  const setupConvergence = await waitForSetupConvergence(desktopApp, den.mocks.witness);
  evidence.recordAssertionEvidence(
    "Setup-triggered engine reloads and MCP registrations converge before route measurement",
    JSON.stringify({
      requiredQuietWindowMs: setupQuietWindowMs,
      quietForMs: setupConvergence.quietForMs,
      settledAt: setupConvergence.settledAt,
      sync: setupConvergence.sync,
      runtime: setupConvergence.runtime,
      mcp: { initialize: setupConvergence.mcp.initialize, toolsList: setupConvergence.mcp.toolsList },
      mcpRpcTail: setupConvergence.mcp.facts.slice(-20),
      disposes: setupConvergence.probe.disposes,
      eventConnections: setupConvergence.probe.eventConnections,
      transitions: setupConvergence.transitions,
      error: setupConvergence.error,
    }),
    setupConvergence.converged
      && setupConvergence.sync.hasSession
      && setupConvergence.sync.reloadPending === false
      && (setupConvergence.sync.lastRunStatus === "applied" || setupConvergence.sync.lastRunStatus === "noop")
      && setupConvergence.quietForMs >= setupQuietWindowMs,
  );
  expect(setupConvergence.converged, JSON.stringify(setupConvergence)).toBe(true);
  expect(setupConvergence.sync.reloadPending).toBe(false);
  const initialRuntime = setupConvergence.runtime;
  expect(initialRuntime.enginePid).not.toBeNull();
  expect(initialRuntime.generations.length).toBeGreaterThan(0);
  expect(initialRuntime.generations.every((generation) => generation.pid !== null && generation.spawnedAt !== null)).toBe(true);

  // Control: repeated navigation to the already-selected workspace is a true
  // no-op. Its positive half is coherent A adoption; its negative half is zero
  // activation, dispose, process-generation, or MCP handshake change.
  const noOpStartActivations = await readActivationFacts(desktopApp, workspaceIds);
  const noOpStartProbe = await readLifecycleProbe(desktopApp);
  const noOpStartMcp = await readMcpRpcCounts(den.mocks.witness);
  const noOpStartRuntime = await readEngineRuntime(desktopApp);
  for (let index = 0; index < 3; index += 1) await go(desktopApp, `/workspace/${workspaceA}/session`);
  const noOpListing = await waitForWorkspaceRoute(desktopApp, workspaceA);
  const noOpSettled = await waitForMcpSettled(den.mocks.witness, noOpStartMcp);
  const noOpEndActivations = await readActivationFacts(desktopApp, workspaceIds);
  const noOpEndProbe = await readLifecycleProbe(desktopApp);
  const noOpEndRuntime = await readEngineRuntime(desktopApp);
  const noOpActivations = noOpEndActivations.slice(noOpStartActivations.length);
  const noOpDisposes = noOpEndProbe.disposes.slice(noOpStartProbe.disposes.length);
  const noOpMcp = mcpDelta(noOpStartMcp, noOpSettled.counts);
  const noOpMcpFacts = mcpFactsDelta(noOpStartMcp, noOpSettled.counts);
  const noOpRuntimeStable = runtimeStayedOn(noOpStartRuntime, [noOpEndRuntime]);
  evidence.recordAssertionEvidence(
    "Same-workspace routing is lifecycle- and MCP-idempotent",
    JSON.stringify({
      activeId: noOpListing.activeId,
      activations: noOpActivations,
      disposes: noOpDisposes,
      mcpDelta: noOpMcp,
      mcpRequests: noOpMcpFacts,
      eventConnections: {
        before: noOpStartProbe.eventConnections,
        after: noOpEndProbe.eventConnections,
      },
      runtimeBefore: noOpStartRuntime,
      runtimeAfter: noOpEndRuntime,
    }),
    noOpListing.activeId === workspaceA
      && noOpActivations.length === 0
      && noOpDisposes.length === 0
      && noOpMcp.initialize === 0
      && noOpMcp.toolsList === 0
      && noOpRuntimeStable,
  );
  expect(noOpListing.activeId).toBe(workspaceA);
  expect(noOpActivations).toEqual([]);
  expect(noOpDisposes).toEqual([]);
  expect(noOpMcp).toEqual({ initialize: 0, toolsList: 0 });
  expect(noOpRuntimeStable).toBe(true);

  // Serialized changed routes: every next route waits for the server's durable
  // audit admission and activeId before the following route begins.
  const serialTargets = [workspaceB, workspaceA, workspaceB, workspaceA];
  const serialStartActivations = noOpEndActivations;
  const serialStartProbe = noOpEndProbe;
  const serialStartMcp = noOpSettled.counts;
  const serialRuntimeObservations: EngineRuntimeFact[] = [noOpEndRuntime];
  const serialStartSync = await readCloudProviderSync(desktopApp);
  const serialStartReloadEvents = await readReloadEvents(desktopApp, workspaceIds);
  const serialStartLog = await readDaytonaLogTail(desktopApp);
  for (let index = 0; index < serialTargets.length; index += 1) {
    serialRuntimeObservations.push(await switchAndWaitForAdmission(
      desktopApp,
      workspaceIds,
      serialTargets[index] ?? "",
      serialStartActivations.length + index + 1,
    ));
  }
  const serialMcpSettled = await waitForMcpSettled(den.mocks.witness, {
    initialize: serialStartMcp.initialize + 1,
    toolsList: serialStartMcp.toolsList + 1,
  });
  const serialSettledRuntime = await readEngineRuntime(desktopApp);
  serialRuntimeObservations.push(serialSettledRuntime);
  const serialEndActivations = await readActivationFacts(desktopApp, workspaceIds);
  const serialEndProbe = await readLifecycleProbe(desktopApp);
  const [serialEndSync, serialEndReloadEvents, serialEndLog] = await Promise.all([
    readCloudProviderSync(desktopApp),
    readReloadEvents(desktopApp, workspaceIds, serialStartReloadEvents.cursor),
    readDaytonaLogTail(desktopApp),
  ]);
  const serialLogDelta = tailDelta(serialStartLog.raw, serialEndLog.raw);
  const serialEngineLogFacts = parseEngineLogFacts(serialLogDelta.text);
  const serialEngineLogSignals = engineLogSignalCounts(serialEngineLogFacts);
  const serialActivations = serialEndActivations.slice(serialStartActivations.length);
  const serialDisposes = serialEndProbe.disposes.slice(serialStartProbe.disposes.length);
  const serialMcp = mcpDelta(serialStartMcp, serialMcpSettled.counts);
  const serialMcpFacts = mcpFactsDelta(serialStartMcp, serialMcpSettled.counts);
  const serialRuntimeStable = runtimeStayedOn(noOpEndRuntime, serialRuntimeObservations);
  const serialActivationIds = serialActivations.map((activation) => activation.workspaceId);
  const serialDisposeCounts = countByWorkspace(serialDisposes);
  // Each activation owns one directory dispose. The first changed route may
  // additionally flush one coalesced config reload; each lifecycle cycle can
  // reconnect each of the two directory-scoped MCP witnesses at most once.
  const serialLifecycleBounded = serialDisposes.length >= serialActivations.length
    && serialDisposes.length <= serialActivations.length + 1;
  const serialMcpLimit = workspaceIds.length * (serialActivations.length + 1);
  const serialMcpBounded = serialMcp.initialize >= 1
    && serialMcp.initialize <= serialMcpLimit
    && serialMcp.toolsList >= 1
    && serialMcp.toolsList <= serialMcpLimit;
  const serialCloudSyncStable = serialEndSync.lastRunAt === serialStartSync.lastRunAt;
  evidence.recordAssertionEvidence(
    "Serialized A-B routing reloads instances in place without process or MCP amplification",
    JSON.stringify({
      targets: serialTargets,
      activations: serialActivations,
      disposes: serialDisposes,
      activationCounts: countByWorkspace(serialActivations),
      disposeCounts: serialDisposeCounts,
      mcpDelta: serialMcp,
      mcpLimit: serialMcpLimit,
      mcpRequests: serialMcpFacts,
      eventConnections: {
        before: serialStartProbe.eventConnections,
        after: serialEndProbe.eventConnections,
      },
      runtimeObservations: serialRuntimeObservations,
      cloudProviderSync: {
        before: serialStartSync,
        after: serialEndSync,
      },
      reloadEvents: {
        beforeCursor: serialStartReloadEvents.cursor,
        afterCursor: serialEndReloadEvents.cursor,
        duringSerializedSwitches: serialEndReloadEvents.items,
      },
      engineLog: {
        sandboxId: serialEndLog.sandboxId,
        logPath: serialEndLog.logPath,
        tailBytes: daytonaLogTailBytes,
        beforeCapturedAt: serialStartLog.capturedAt,
        afterCapturedAt: serialEndLog.capturedAt,
        overlapFound: serialLogDelta.overlap,
        deltaBytes: serialLogDelta.text.length,
        signals: serialEngineLogSignals,
        filteredTail: serialEngineLogFacts,
      },
    }),
    serialActivationIds.join(",") === serialTargets.join(",")
      && serialLifecycleBounded
      && serialMcpBounded
      && serialRuntimeStable
      && serialCloudSyncStable
      && serialEngineLogSignals.rollover === 0,
  );
  expect(serialActivationIds).toEqual(serialTargets);
  expect(serialLifecycleBounded, JSON.stringify(serialDisposes)).toBe(true);
  expect(serialMcpSettled.reachedMinimum, JSON.stringify(serialMcpSettled)).toBe(true);
  expect(serialMcpBounded, JSON.stringify(serialMcp)).toBe(true);
  expect(serialRuntimeStable, JSON.stringify(serialRuntimeObservations)).toBe(true);
  expect(serialCloudSyncStable, JSON.stringify({ before: serialStartSync, after: serialEndSync })).toBe(true);
  expect(serialEngineLogSignals.rollover, JSON.stringify(serialEngineLogFacts)).toBe(0);

  // Burst: seven hash-route changes run in one renderer task sequence with no
  // dwell. The final B route must win, while the 750ms product settle window
  // may coalesce intermediate clicks. Lifecycle/MCP work is bounded by admitted
  // activations rather than by clicks.
  const burstTargets = [workspaceB, workspaceA, workspaceB, workspaceA, workspaceB, workspaceA, workspaceB];
  const burstStartActivations = serialEndActivations;
  const burstStartProbe = serialEndProbe;
  const burstStartMcp = serialMcpSettled.counts;
  const burstStartRuntime = serialSettledRuntime;
  await runZeroDwellBurst(desktopApp, burstTargets);
  const finalWorkspaceId = workspaceB;
  await eventually(() => readActivationFacts(desktopApp, workspaceIds), {
    within: 60_000,
    intervalMs: 250,
    label: "zero-dwell burst admits its final workspace",
    until: (activations) => activations.length > burstStartActivations.length
      && activations.at(-1)?.workspaceId === finalWorkspaceId,
  });
  const burstListing = await waitForWorkspaceRoute(desktopApp, finalWorkspaceId);
  const burstMcpSettled = await waitForMcpSettled(den.mocks.witness, {
    initialize: burstStartMcp.initialize + 1,
    toolsList: burstStartMcp.toolsList + 1,
  });
  const burstEndActivations = await readActivationFacts(desktopApp, workspaceIds);
  const burstEndProbe = await readLifecycleProbe(desktopApp);
  const burstEndRuntime = await readEngineRuntime(desktopApp);
  const burstActivations = burstEndActivations.slice(burstStartActivations.length);
  const burstDisposes = burstEndProbe.disposes.slice(burstStartProbe.disposes.length);
  const burstMcp = mcpDelta(burstStartMcp, burstMcpSettled.counts);
  const burstMcpFacts = mcpFactsDelta(burstStartMcp, burstMcpSettled.counts);
  const burstActivationIds = burstActivations.map((activation) => activation.workspaceId);
  const burstActivationCounts = countByWorkspace(burstActivations);
  const burstDisposeCounts = countByWorkspace(burstDisposes);
  const burstCoalesced = burstActivations.length >= 1 && burstActivations.length <= 3
    && burstActivations.length < burstTargets.length
    && burstActivationIds.at(-1) === finalWorkspaceId;
  const burstMcpLimit = workspaceIds.length * (burstActivations.length + 1);
  const burstLifecycleBounded = burstDisposes.length >= burstActivations.length
    && burstDisposes.length <= burstActivations.length + 1
    && burstMcp.initialize >= 1
    && burstMcp.initialize <= burstMcpLimit
    && burstMcp.toolsList >= 1
    && burstMcp.toolsList <= burstMcpLimit;
  const burstRuntimeStable = runtimeStayedOn(burstStartRuntime, [burstEndRuntime]);
  evidence.recordAssertionEvidence(
    "A zero-dwell route burst converges without lifecycle, process, or MCP amplification",
    JSON.stringify({
      clicks: burstTargets,
      finalActiveId: burstListing.activeId,
      activations: burstActivations,
      disposes: burstDisposes,
      activationCounts: burstActivationCounts,
      disposeCounts: burstDisposeCounts,
      mcpDelta: burstMcp,
      mcpLimit: burstMcpLimit,
      mcpRequests: burstMcpFacts,
      eventConnections: {
        before: burstStartProbe.eventConnections,
        after: burstEndProbe.eventConnections,
      },
      runtimeBefore: burstStartRuntime,
      runtimeAfter: burstEndRuntime,
    }),
    burstListing.activeId === finalWorkspaceId
      && burstCoalesced
      && burstLifecycleBounded
      && burstRuntimeStable,
  );
  expect(burstListing.activeId).toBe(finalWorkspaceId);
  expect(burstCoalesced, JSON.stringify(burstActivations)).toBe(true);
  expect(burstDisposes).toHaveLength(burstActivations.length);
  expect(burstMcpSettled.reachedMinimum, JSON.stringify(burstMcpSettled)).toBe(true);
  expect(burstLifecycleBounded, JSON.stringify(burstMcp)).toBe(true);
  expect(burstRuntimeStable, JSON.stringify({ burstStartRuntime, burstEndRuntime })).toBe(true);

  await evalIn(desktopApp, `(() => {
    if (window.__owWorkspaceEngineMcpChurn) window.__owWorkspaceEngineMcpChurn.active = false;
    return true;
  })()`);
});
