#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
}

function requiredArg(name) {
  const value = argValue(name, "");
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function assertHex(value, size, label) {
  if (!new RegExp(`^[0-9a-f]{${size}}$`).test(value)) {
    throw new Error(`${label} must be ${size} lowercase hex characters`);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeValue(value) {
  if (!isObject(value)) return value;
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("boolValue" in value) return Boolean(value.boolValue);
  if ("bytesValue" in value) return value.bytesValue;
  if (isObject(value.arrayValue)) {
    const values = Array.isArray(value.arrayValue.values) ? value.arrayValue.values : [];
    return values.map(normalizeValue);
  }
  if (isObject(value.kvlistValue)) {
    return attributesToMap(value.kvlistValue.values);
  }
  if ("value" in value && Object.keys(value).length <= 3) return normalizeValue(value.value);
  return value;
}

function attributesToMap(attributes) {
  const out = {};
  if (Array.isArray(attributes)) {
    for (const item of attributes) {
      if (!isObject(item) || typeof item.key !== "string") continue;
      out[item.key] = normalizeValue("value" in item ? item.value : item);
    }
    return out;
  }
  if (isObject(attributes)) {
    for (const [key, value] of Object.entries(attributes)) out[key] = normalizeValue(value);
  }
  return out;
}

function serviceName(attrs) {
  const value = attrs["service.name"] ?? attrs.service_name ?? attrs.serviceName;
  return typeof value === "string" ? value : undefined;
}

function spanId(span) {
  const value = span.spanId ?? span.spanID ?? span.span_id;
  if (typeof value !== "string") return undefined;
  if (/^[0-9a-f]{16}$/iu.test(value)) return value.toLowerCase();
  return Buffer.from(value, "base64").toString("hex");
}

function collectTraceSpans(payload) {
  const spans = [];
  const seen = new Set();

  function pushSpan(span, resource) {
    if (!isObject(span) || typeof span.name !== "string") return;
    const id = spanId(span) ?? `${span.name}:${spans.length}`;
    const dedupeKey = `${id}:${span.name}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    spans.push({
      attributes: attributesToMap(span.attributes ?? span.tags),
      name: span.name,
      resource,
      spanId: id,
    });
  }

  function walk(node, inheritedResource = {}) {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, inheritedResource);
      return;
    }
    if (!isObject(node)) return;

    if (isObject(node.processes) && Array.isArray(node.spans)) {
      for (const span of node.spans) {
        const process = isObject(span) && typeof span.processID === "string" ? node.processes[span.processID] : undefined;
        const processResource = isObject(process)
          ? { ...attributesToMap(process.tags), "service.name": process.serviceName }
          : inheritedResource;
        pushSpan(span, processResource);
      }
      return;
    }

    let resource = inheritedResource;
    if (isObject(node.resource)) {
      resource = { ...resource, ...attributesToMap(node.resource.attributes) };
    }

    for (const key of ["resourceSpans", "batches", "data", "trace"]) {
      if (Array.isArray(node[key]) || isObject(node[key])) walk(node[key], resource);
    }
    for (const key of ["scopeSpans", "instrumentationLibrarySpans"]) {
      if (Array.isArray(node[key])) walk(node[key], resource);
    }
    if (Array.isArray(node.spans)) {
      for (const span of node.spans) pushSpan(span, resource);
    }
  }

  walk(payload);
  return spans;
}

function analyzeTrace(payload, traceId) {
  const spans = collectTraceSpans(payload);
  const services = [...new Set(spans.map((span) => serviceName(span.resource)).filter(Boolean))].sort();
  const webSpans = spans.filter((span) => serviceName(span.resource) === "den-web");
  const apiSpans = spans.filter((span) => serviceName(span.resource) === "den-api");
  const honoSpan = apiSpans.find((span) => {
    const route = span.attributes["http.route"];
    return route === "/openapi.json" && typeof span.attributes["request.id"] === "string";
  });

  return {
    apiSpanIds: apiSpans.map((span) => span.spanId).filter(Boolean),
    hasApi: services.includes("den-api"),
    hasWeb: services.includes("den-web"),
    honoSpan: honoSpan
      ? {
          name: honoSpan.name,
          requestId: honoSpan.attributes["request.id"],
          route: honoSpan.attributes["http.route"],
          spanId: honoSpan.spanId,
        }
      : undefined,
    services,
    spanCount: spans.length,
    traceId,
    webSpanIds: webSpans.map((span) => span.spanId).filter(Boolean),
  };
}

function collectStringField(value, names) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = collectStringField(item, names);
      if (found) return found;
    }
    return undefined;
  }
  if (!isObject(value)) return undefined;
  for (const name of names) {
    const item = value[name];
    if (typeof item === "string") return item;
  }
  for (const item of Object.values(value)) {
    const found = collectStringField(item, names);
    if (found) return found;
  }
  return undefined;
}

function collectLokiEntries(payload) {
  const results = Array.isArray(payload?.data?.result) ? payload.data.result : [];
  const entries = [];
  for (const stream of results) {
    const labels = isObject(stream.stream) ? stream.stream : {};
    const values = Array.isArray(stream.values) ? stream.values : [];
    for (const value of values) {
      if (!Array.isArray(value)) continue;
      const line = typeof value[1] === "string" ? value[1] : "";
      const parsedLine = safeJsonParse(line);
      const metadata = isObject(value[2]) ? value[2] : {};
      const fields = {
        ...labels,
        ...metadata,
        ...(isObject(parsedLine) ? parsedLine : {}),
      };
      const text = `${line}\n${JSON.stringify(metadata)}`;
      entries.push({
        body: typeof fields.body === "string" ? fields.body : typeof fields.message === "string" ? fields.message : line,
        fields,
        line,
        serviceName: fields.service_name ?? fields["service.name"] ?? fields.service,
        spanId: (collectStringField(fields, ["span_id", "spanid", "spanId", "spanID"]) ?? text.match(/[0-9a-f]{16}/)?.[0])?.toLowerCase(),
        text,
        traceId: (collectStringField(fields, ["trace_id", "traceid", "traceId", "traceID"]) ?? text.match(/[0-9a-f]{32}/)?.[0])?.toLowerCase(),
      });
    }
  }
  return entries;
}

function summarizeLogEntry(entry) {
  return {
    body: entry.body,
    serviceName: entry.serviceName,
    spanId: entry.spanId,
    traceId: entry.traceId,
  };
}

function analyzeServiceLog(payload, traceId, spanIds, serviceName, bodyNeedle) {
  const spanIdSet = new Set(spanIds);
  const entries = collectLokiEntries(payload);
  const matching = entries.find((entry) => {
    const bodyMatches = bodyNeedle === undefined || entry.body.includes(bodyNeedle) || entry.line.includes(bodyNeedle);
    return entry.serviceName === serviceName
      && entry.traceId === traceId
      && typeof entry.spanId === "string"
      && spanIdSet.has(entry.spanId)
      && bodyMatches;
  });
  return {
    entries: entries.length,
    match: matching ? summarizeLogEntry(matching) : undefined,
    serviceName,
  };
}

function analyzeMetricSeries(payload, options) {
  const results = Array.isArray(payload?.data?.result) ? payload.data.result : [];
  for (const item of results) {
    const metric = isObject(item.metric) ? item.metric : {};
    const rawValue = Array.isArray(item.value) ? item.value[1] : undefined;
    const value = Number(rawValue);
    if (metric.service_name !== options.serviceName) continue;
    if (options.route !== undefined && metric.http_route !== options.route) continue;
    if (!Number.isFinite(value)) continue;
    if (options.requirePositive && value <= 0) continue;
    return {
      labels: metric,
      name: metric.__name__,
      value,
    };
  }
  return undefined;
}

function runtimeErrorLines(logs) {
  const patterns = [
    /\bunhandled(?:rejection| exception)?\b/i,
    /\buncaught(?:exception)?\b/i,
    /UnhandledPromiseRejection/i,
    /\b(?:TypeError|ReferenceError|SyntaxError|RangeError):/,
    /\bERR_[A-Z0-9_]+:/,
    /"level"\s*:\s*"error"/i,
    /\blevel=error\b/i,
    /\brequest failed\b/i,
  ];
  return logs
    .split("\n")
    .filter((line) => patterns.some((pattern) => pattern.test(line)))
    .slice(0, 20);
}

function stripComposePrefix(line) {
  const marker = " | ";
  const index = line.indexOf(marker);
  return (index === -1 ? line : line.slice(index + marker.length)).trim();
}

function parseDockerJsonEntries(logs) {
  const entries = [];
  for (const rawLine of logs.split("\n")) {
    const line = stripComposePrefix(rawLine);
    const payload = safeJsonParse(line);
    if (!isObject(payload)) continue;
    entries.push({ line, payload, rawLine });
  }
  return entries;
}

function summarizeStdoutEntry(entry) {
  if (entry === undefined) return undefined;
  return {
    durationMs: entry.payload.duration_ms,
    level: entry.payload.level,
    message: entry.payload.message,
    route: entry.payload.http_route ?? entry.payload.upstream_path,
    service: entry.payload.service,
    status: entry.payload.http_status_code ?? entry.payload.status,
  };
}

function exporterAttemptLines(logs) {
  const patterns = [
    /ECONNREFUSED.*(?:4318|otel|otlp|collector|lgtm)/i,
    /(?:OTLP|otel|collector|exporter).*(?:ECONNREFUSED|failed|failure|error|connect)/i,
    /(?:failed|failure|error|connect).*(?:OTLP|otel|collector|exporter|4318|lgtm)/i,
  ];
  return logs
    .split("\n")
    .filter((line) => patterns.some((pattern) => pattern.test(line)))
    .slice(0, 20);
}

function analyzeNoneStdout(logs, secret) {
  const entries = parseDockerJsonEntries(logs);
  const web = entries.find((entry) => {
    return entry.payload.service === "den-web"
      && entry.payload.message === "den-web upstream proxy completed"
      && entry.payload.upstream_path === "/openapi.json"
      && Number(entry.payload.status) === 200;
  });
  const api = entries.find((entry) => {
    return entry.payload.service === "den-api"
      && entry.payload.message === "request completed"
      && entry.payload.http_route === "/openapi.json"
      && Number(entry.payload.http_status_code) === 200;
  });

  return {
    api: summarizeStdoutEntry(api),
    dockerLogSecretAbsent: !logs.includes(secret),
    exporterAttemptLines: exporterAttemptLines(logs),
    jsonEntryCount: entries.length,
    web: summarizeStdoutEntry(web),
  };
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return { response, text };
}

async function fetchJson(url, options = {}) {
  const { response, text } = await fetchText(url, options);
  const json = safeJsonParse(text);
  if (!response.ok) {
    const message = text.slice(0, 400) || response.statusText;
    throw new Error(`${response.status} ${response.statusText}: ${message}`);
  }
  if (json === undefined) throw new Error(`Expected JSON from ${url}`);
  return json;
}

function basicAuthHeader(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function proxyUrl(grafanaUrl, uid, path) {
  return `${grafanaUrl}/api/datasources/proxy/uid/${encodeURIComponent(uid)}${path}`;
}

function encodeQuery(params) {
  return new URLSearchParams(params).toString();
}

function nsFromMs(ms) {
  return `${BigInt(ms) * 1000000n}`;
}

function selectedDatasources(datasources) {
  const byType = (type) => datasources.find((datasource) => datasource.type === type || datasource.typeName === type);
  const tempo = byType("tempo");
  const loki = byType("loki");
  const prometheus = byType("prometheus");
  if (!tempo || !loki || !prometheus) {
    throw new Error(`Grafana datasources missing tempo/loki/prometheus: ${JSON.stringify(datasources)}`);
  }
  return { tempo, loki, prometheus };
}

async function collectSignals({ auth, datasources, endMs, grafanaUrl, secret, startMs, traceId }) {
  const endNs = nsFromMs(endMs);
  const startNs = nsFromMs(startMs);
  const signal = {
    errors: {},
    metrics: {},
    secretLeakEntries: undefined,
    trace: undefined,
    tracePayload: undefined,
    logs: {},
    logPayloads: {},
  };

  try {
    const tracePayload = await fetchJson(proxyUrl(grafanaUrl, datasources.tempo.uid, `/api/traces/${traceId}`), { headers: auth });
    signal.tracePayload = tracePayload;
    signal.trace = analyzeTrace(tracePayload, traceId);
  } catch (error) {
    signal.errors.trace = error instanceof Error ? error.message : String(error);
  }

  try {
    const query = `{service_name="den-web"} |= "den-web upstream proxy completed"`;
    const params = encodeQuery({ direction: "backward", end: endNs, limit: "100", query, start: startNs });
    const logPayload = await fetchJson(proxyUrl(grafanaUrl, datasources.loki.uid, `/loki/api/v1/query_range?${params}`), { headers: auth });
    signal.logPayloads.web = logPayload;
    signal.logs.web = signal.trace
      ? analyzeServiceLog(logPayload, traceId, signal.trace.webSpanIds, "den-web", "den-web upstream proxy completed")
      : { entries: collectLokiEntries(logPayload).length, serviceName: "den-web" };
  } catch (error) {
    signal.errors.webLog = error instanceof Error ? error.message : String(error);
  }

  try {
    const query = `{service_name="den-api"} |= "request completed"`;
    const params = encodeQuery({ direction: "backward", end: endNs, limit: "100", query, start: startNs });
    const logPayload = await fetchJson(proxyUrl(grafanaUrl, datasources.loki.uid, `/loki/api/v1/query_range?${params}`), { headers: auth });
    signal.logPayloads.api = logPayload;
    signal.logs.api = signal.trace
      ? analyzeServiceLog(logPayload, traceId, signal.trace.apiSpanIds, "den-api", "request completed")
      : { entries: collectLokiEntries(logPayload).length, serviceName: "den-api" };
  } catch (error) {
    signal.errors.apiLog = error instanceof Error ? error.message : String(error);
  }

  try {
    const query = `{service_name=~"den-web|den-api"} |= ${JSON.stringify(secret)}`;
    const params = encodeQuery({ direction: "backward", end: endNs, limit: "20", query, start: startNs });
    const secretPayload = await fetchJson(proxyUrl(grafanaUrl, datasources.loki.uid, `/loki/api/v1/query_range?${params}`), { headers: auth });
    signal.secretLeakEntries = collectLokiEntries(secretPayload).length;
  } catch (error) {
    signal.errors.secretLogQuery = error instanceof Error ? error.message : String(error);
  }

  try {
    const query = `{__name__=~"http_server_request_duration.*",service_name="den-api",http_route="/openapi.json"}`;
    const params = encodeQuery({ query, time: `${Math.floor(Date.now() / 1000)}` });
    const metricPayload = await fetchJson(proxyUrl(grafanaUrl, datasources.prometheus.uid, `/api/v1/query?${params}`), { headers: auth });
    signal.metrics.duration = analyzeMetricSeries(metricPayload, {
      requirePositive: true,
      route: "/openapi.json",
      serviceName: "den-api",
    });
  } catch (error) {
    signal.errors.durationMetric = error instanceof Error ? error.message : String(error);
  }

  try {
    const query = `{__name__=~"http_server_active_requests.*",service_name="den-api"}`;
    const params = encodeQuery({ query, time: `${Math.floor(Date.now() / 1000)}` });
    const metricPayload = await fetchJson(proxyUrl(grafanaUrl, datasources.prometheus.uid, `/api/v1/query?${params}`), { headers: auth });
    signal.metrics.active = analyzeMetricSeries(metricPayload, {
      requirePositive: false,
      serviceName: "den-api",
    });
  } catch (error) {
    signal.errors.activeMetric = error instanceof Error ? error.message : String(error);
  }

  signal.traceSecretAbsent = signal.tracePayload === undefined ? false : !JSON.stringify(signal.tracePayload).includes(secret);
  signal.logSecretAbsent = Object.keys(signal.logPayloads).length > 0 && !JSON.stringify(signal.logPayloads).includes(secret);
  signal.secretLogQueryClean = signal.secretLeakEntries === 0;
  signal.ready = Boolean(
    signal.trace?.hasApi
      && signal.trace?.hasWeb
      && signal.trace?.honoSpan
      && signal.logs.web?.match
      && signal.logs.api?.match
      && signal.metrics.duration
      && signal.metrics.active
      && signal.traceSecretAbsent
      && signal.logSecretAbsent
      && signal.secretLogQueryClean,
  );
  return signal;
}

function composeBaseArgs({ denComposeFile, otelComposeFile, project }) {
  return [
    "compose",
    "-p",
    project,
    "-f",
    denComposeFile,
    "-f",
    otelComposeFile,
  ];
}

function dockerCompose({ args, denComposeFile, env = {}, otelComposeFile, project }) {
  return execFileSync("docker", [
    ...composeBaseArgs({ denComposeFile, otelComposeFile, project }),
    ...args,
  ], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function dockerLogs({ denComposeFile, otelComposeFile, project, since }) {
  const args = [
    ...composeBaseArgs({ denComposeFile, otelComposeFile, project }),
    "logs",
    "--no-color",
  ];
  if (since) args.push("--since", since);
  args.push("den", "web");
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

async function requestOpenApi({ requestPath, secret, traceId = randomBytes(16).toString("hex"), webUrl }) {
  const parentSpanId = randomBytes(8).toString("hex");
  const traceparent = `00-${traceId}-${parentSpanId}-01`;
  const requestResponse = await fetch(`${webUrl}${requestPath}`, {
    headers: {
      traceparent,
      "x-openwork-otel-hono-e2e": traceId,
    },
  });
  const requestBody = await requestResponse.text();
  const openApi = safeJsonParse(requestBody);
  return {
    body: requestBody,
    report: {
      contentType: requestResponse.headers.get("content-type"),
      path: requestPath.replaceAll(secret, "[redacted]"),
      status: requestResponse.status,
      title: openApi?.info?.title,
      traceparent,
    },
    response: requestResponse,
    traceId,
  };
}

async function runNonePhase({ denComposeFile, otelComposeFile, project, requestPath, secret, waitSeconds, webUrl }) {
  const since = new Date(Date.now() - 1000).toISOString();
  const recreateOutput = dockerCompose({
    args: ["up", "-d", "--wait", "--wait-timeout", String(waitSeconds), "--no-build", "den", "web"],
    denComposeFile,
    env: {
      DEN_OBSERVABILITY_BACKEND: "none",
      NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND: "none",
    },
    otelComposeFile,
    project,
  });

  const request = await requestOpenApi({ requestPath, secret, webUrl });
  if (request.response.status !== 200) {
    throw new Error(`Expected HTTP 200 from none backend ${request.report.path}; got ${request.response.status}: ${request.body.slice(0, 400)}`);
  }

  let logs = "";
  let analysis = analyzeNoneStdout(logs, secret);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    logs = dockerLogs({ denComposeFile, otelComposeFile, project, since });
    analysis = analyzeNoneStdout(logs, secret);
    if (analysis.api && analysis.web) break;
    await sleep(2_000);
  }

  return {
    logs: analysis,
    recreateOutput: recreateOutput.trim(),
    request: request.report,
    since,
  };
}

function addAssertion(report, name, ok, evidence) {
  report.assertions.push({ evidence, name, ok });
}

function printSummary(report) {
  const status = report.ok ? "PASS" : "FAIL";
  console.log(`${status} otel-hono-live`);
  console.log(`report: ${report.reportJson}`);
  console.log(`request: ${report.request?.status ?? "n/a"} ${report.request?.path ?? ""}`.trim());
  if (report.evidence?.trace) {
    const trace = report.evidence.trace;
    console.log(`trace: ${trace.traceId} services=${trace.services.join(",")} hono=${trace.honoSpan?.name ?? "missing"} request.id=${trace.honoSpan?.requestId ?? "missing"}`);
  }
  if (report.evidence?.logs?.web?.match) {
    const log = report.evidence.logs.web.match;
    console.log(`log: den-web trace_id=${log.traceId} span_id=${log.spanId}`);
  }
  if (report.evidence?.logs?.api?.match) {
    const log = report.evidence.logs.api.match;
    console.log(`log: den-api trace_id=${log.traceId} span_id=${log.spanId}`);
  }
  if (report.evidence?.metrics?.duration) {
    console.log(`metric: ${report.evidence.metrics.duration.name} route=/openapi.json value=${report.evidence.metrics.duration.value}`);
  }
  if (report.evidence?.metrics?.active) {
    console.log(`metric: ${report.evidence.metrics.active.name} active_value=${report.evidence.metrics.active.value}`);
  }
  if (report.evidence?.none) {
    const none = report.evidence.none;
    console.log(`none: ${none.request.status} stdout_web=${Boolean(none.logs.web)} stdout_api=${Boolean(none.logs.api)} exporter_attempts=${none.logs.exporterAttemptLines.length}`);
  }
  if (!report.ok && report.error) console.error(report.error);
}

async function main() {
  const reportJson = requiredArg("report-json");
  const grafanaUrl = trimTrailingSlash(requiredArg("grafana-url"));
  const webUrl = trimTrailingSlash(requiredArg("web-url"));
  const project = requiredArg("project");
  const denComposeFile = requiredArg("den-compose-file");
  const otelComposeFile = requiredArg("otel-compose-file");
  const secret = argValue("secret", process.env.OTEL_HONO_SECRET ?? "super-secret");
  const requestPath = argValue("request-path", `/api/den/openapi.json?token=${encodeURIComponent(secret)}`);
  const timeoutMs = Number(process.env.OTEL_HONO_POLL_SECONDS ?? "240") * 1000;
  const intervalMs = Number(process.env.OTEL_HONO_POLL_INTERVAL_SECONDS ?? "5") * 1000;
  const grafanaUser = process.env.OTEL_HONO_GRAFANA_USER ?? "admin";
  const grafanaPassword = process.env.OTEL_HONO_GRAFANA_PASSWORD ?? "admin";
  const traceId = process.env.OTEL_HONO_TRACE_ID ?? randomBytes(16).toString("hex");
  const waitSeconds = process.env.OTEL_HONO_COMPOSE_WAIT_SECONDS ?? "420";
  assertHex(traceId, 32, "OTEL_HONO_TRACE_ID");

  const report = {
    assertions: [],
    datasources: undefined,
    endedAt: undefined,
    error: undefined,
    evidence: {},
    ok: false,
    ports: {
      denApi: process.env.DEN_API_PORT,
      denWeb: process.env.DEN_WEB_PORT,
      grafana: process.env.OTEL_LGTM_GRAFANA_PORT,
      otlpHttp: process.env.OTEL_LGTM_OTLP_HTTP_PORT,
    },
    project,
    reportJson,
    request: undefined,
    startedAt: nowIso(),
  };

  try {
    const auth = { Authorization: basicAuthHeader(grafanaUser, grafanaPassword) };
    await fetchJson(`${grafanaUrl}/api/health`, { headers: auth });
    const datasources = selectedDatasources(await fetchJson(`${grafanaUrl}/api/datasources`, { headers: auth }));
    report.datasources = {
      loki: { name: datasources.loki.name, type: datasources.loki.type, uid: datasources.loki.uid },
      prometheus: { name: datasources.prometheus.name, type: datasources.prometheus.type, uid: datasources.prometheus.uid },
      tempo: { name: datasources.tempo.name, type: datasources.tempo.type, uid: datasources.tempo.uid },
    };

    const startMs = Date.now() - 30_000;
    const otelRequest = await requestOpenApi({ requestPath, secret, traceId, webUrl });
    report.request = otelRequest.report;
    addAssertion(report, "http_200", otelRequest.response.status === 200, report.request);
    if (otelRequest.response.status !== 200) {
      throw new Error(`Expected HTTP 200 from ${otelRequest.report.path}; got ${otelRequest.response.status}: ${otelRequest.body.slice(0, 400)}`);
    }

    let lastSignal;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      lastSignal = await collectSignals({
        auth,
        datasources,
        endMs: Date.now() + 5_000,
        grafanaUrl,
        secret,
        startMs,
        traceId,
      });
      if (lastSignal.ready) break;
      await sleep(intervalMs);
    }

    report.evidence.poll = {
      attemptsEndedAt: nowIso(),
      lastErrors: lastSignal?.errors,
      timeoutSeconds: timeoutMs / 1000,
    };
    if (!lastSignal?.ready) {
      report.evidence.lastSignal = {
        logs: lastSignal?.logs,
        metrics: lastSignal?.metrics,
        secretLeakEntries: lastSignal?.secretLeakEntries,
        trace: lastSignal?.trace,
      };
      throw new Error("Timed out polling Grafana datasource proxy APIs for trace, log, and metric evidence");
    }

    report.evidence.trace = lastSignal.trace;
    report.evidence.logs = lastSignal.logs;
    report.evidence.log = lastSignal.logs.web;
    report.evidence.metrics = lastSignal.metrics;
    report.evidence.metric = lastSignal.metrics.duration;
    report.evidence.secret = {
      lokiSecretQueryEntries: lastSignal.secretLeakEntries,
      logPayloadAbsent: lastSignal.logSecretAbsent,
      tracePayloadAbsent: lastSignal.traceSecretAbsent,
    };
    addAssertion(report, "trace_contains_den_web_and_den_api", lastSignal.trace.hasApi && lastSignal.trace.hasWeb, lastSignal.trace.services);
    addAssertion(report, "hono_openapi_span_has_request_id", Boolean(lastSignal.trace.honoSpan), lastSignal.trace.honoSpan);
    addAssertion(report, "secret_absent_from_trace_and_loki_log_output", lastSignal.traceSecretAbsent && lastSignal.logSecretAbsent && lastSignal.secretLeakEntries === 0, report.evidence.secret);
    addAssertion(report, "den_web_log_trace_span_matches_trace", Boolean(lastSignal.logs.web.match), lastSignal.logs.web.match);
    addAssertion(report, "den_api_log_trace_span_matches_trace", Boolean(lastSignal.logs.api.match), lastSignal.logs.api.match);
    addAssertion(report, "den_api_hono_duration_metric_exists", Boolean(lastSignal.metrics.duration), lastSignal.metrics.duration);
    addAssertion(report, "den_api_hono_active_requests_metric_exists", Boolean(lastSignal.metrics.active), lastSignal.metrics.active);

    const none = await runNonePhase({
      denComposeFile,
      otelComposeFile,
      project,
      requestPath,
      secret,
      waitSeconds,
      webUrl,
    });
    report.evidence.none = none;
    report.none = none;
    addAssertion(report, "none_backend_http_200", none.request.status === 200, none.request);
    addAssertion(report, "none_backend_json_stdout_request_logs", Boolean(none.logs.web && none.logs.api), none.logs);
    addAssertion(report, "none_backend_no_exporter_connection_or_error_attempt", none.logs.exporterAttemptLines.length === 0, { exporterAttemptLines: none.logs.exporterAttemptLines });
    addAssertion(report, "none_backend_secret_absent_from_docker_logs", none.logs.dockerLogSecretAbsent, { dockerLogSecretAbsent: none.logs.dockerLogSecretAbsent });

    const logs = dockerLogs({ denComposeFile, otelComposeFile, project });
    const errors = runtimeErrorLines(logs);
    const dockerLogSecretAbsent = !logs.includes(secret);
    report.evidence.runtime = {
      dockerLogSecretAbsent,
      errorLines: errors,
      inspectedServices: ["den", "web"],
    };
    addAssertion(report, "secret_absent_from_docker_runtime_logs", dockerLogSecretAbsent, { dockerLogSecretAbsent });
    addAssertion(report, "no_unhandled_runtime_errors", errors.length === 0, { errorLines: errors });

    report.ok = report.assertions.every((assertion) => assertion.ok);
    if (!report.ok) throw new Error("One or more live validator assertions failed");
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    report.error = message.replaceAll(secret, "[redacted]");
  } finally {
    report.endedAt = nowIso();
    await mkdir(dirname(reportJson), { recursive: true });
    await writeFile(reportJson, `${JSON.stringify(report, null, 2)}\n`);
    printSummary(report);
  }

  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
