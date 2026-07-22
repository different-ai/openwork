/**
 * Internal demo: Den Hono observability runtime proof.
 *
 * Runs app-less (requiresApp: false). The protagonist is the reviewer reading
 * deterministic terminal evidence: one live Docker LGTM validator for frames
 * 1-4 plus targeted source tests for the backend selection frames.
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "otel-hono";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const LIVE_REPORT_PATH = join(ROOT, "tmp", `otel-hono-fraimz-${process.pid}.json`);
let liveValidation;

function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

function commandLine(command, args) {
  return [command, ...args].map(shellQuote).join(" ");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}${result.error ? `\n${result.error.message}` : ""}`.trim();
  return {
    command: commandLine(command, args),
    output,
    signal: result.signal,
    status: result.status,
  };
}

function bunTest(paths, pattern) {
  return run("pnpm", [
    "exec",
    "bun",
    "test",
    ...paths,
    "--test-name-pattern",
    pattern,
  ]);
}

function nodeCheck(script) {
  return run("node", ["-e", script]);
}

function commandOutput(result) {
  const exit = result.status === null ? `signal=${result.signal}` : `exit=${result.status}`;
  return [`$ ${result.command}`, exit, "", result.output || "(no stdout/stderr)"].join("\n");
}

function tail(text, count = 8) {
  return String(text || "")
    .split("\n")
    .slice(-count)
    .join("\n")
    .trim();
}

function commandPassed(result) {
  return Boolean(result) && result.status === 0;
}

function commandTail(result) {
  return result ? tail(result.output) : "command did not run";
}

function witness(ctx, condition, assertion, actual = "") {
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual });
    ctx.assert(false, `${assertion}${actual ? ` (actual: ${actual})` : ""}`);
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

async function getLiveValidation() {
  if (liveValidation) return liveValidation;

  const reportPath = process.env.OTEL_HONO_REPORT_JSON || LIVE_REPORT_PATH;
  await mkdir(dirname(reportPath), { recursive: true });
  await rm(reportPath, { force: true });
  const command = run("bash", ["packaging/docker/otel-hono-live-validate.sh"], {
    env: {
      ...process.env,
      OTEL_HONO_REPORT_JSON: reportPath,
    },
    maxBuffer: 64 * 1024 * 1024,
    timeout: Number(process.env.OTEL_HONO_FLOW_VALIDATOR_TIMEOUT_MS || "1200000"),
  });
  let report;
  let readError;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (error) {
    report = null;
    readError = error instanceof Error ? error.message : String(error);
  }
  liveValidation = { command, readError, report, reportPath };
  return liveValidation;
}

function assertionPassed(report, name) {
  return report?.assertions?.some((assertion) => assertion.name === name && assertion.ok === true) === true;
}

function reportSection(report, keys) {
  if (!report) return "live validator did not produce a JSON report";
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, report[key] ?? report.evidence?.[key]])), null, 2);
}

export default {
  id: FLOW_ID,
  title: "Den services provide configurable, correlated observability without app UI",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Shared OTEL config gives den-web and den-api distinct identities",
      run: async (ctx) => {
        let validation;
        await ctx.prove("The OTEL backend uses one collector config while preserving service.name for den-web and den-api", {
          voiceover: vo[0],
          action: async () => {
            validation = await getLiveValidation();
            ctx.output("live-docker-validator", commandOutput(validation.command));
            ctx.output("live-service-evidence", reportSection(validation.report, ["ok", "project", "datasources", "trace"]));
          },
          assert: async () => {
            witness(ctx, commandPassed(validation?.command), "The live merged Docker validator passes", commandTail(validation?.command));
            witness(ctx, validation?.report?.ok === true, "The validator emits a passing JSON report", validation?.readError || validation?.reportPath);
            witness(ctx, assertionPassed(validation?.report, "trace_contains_den_web_and_den_api"), "Tempo stores den-web and den-api resources in one connected trace", reportSection(validation?.report, ["trace"]));
          },
        });
      },
    },
    {
      name: "Web-to-API traces propagate and API routes are normalized/redacted",
      run: async (ctx) => {
        let validation;
        await ctx.prove("A Den web proxy request carries W3C trace context into Den API, whose logs use safe route labels", {
          voiceover: vo[1],
          action: async () => {
            validation = await getLiveValidation();
            ctx.output("live-request-and-trace-evidence", reportSection(validation.report, ["request", "trace", "assertions"]));
          },
          assert: async () => {
            witness(ctx, validation?.report?.request?.status === 200, "The real den-web proxied OpenAPI request returns HTTP 200");
            witness(ctx, validation?.report?.evidence?.trace?.honoSpan?.route === "/openapi.json", "The stored Hono span uses the normalized /openapi.json route");
            witness(ctx, Boolean(validation?.report?.evidence?.trace?.honoSpan?.requestId), "The stored Hono span carries request.id");
            witness(ctx, assertionPassed(validation?.report, "secret_absent_from_trace_and_loki_log_output"), "The request secret is absent from stored trace and log output", reportSection(validation?.report, ["secret"]));
          },
        });
      },
    },
    {
      name: "OTLP logs carry trace correlation",
      run: async (ctx) => {
        let validation;
        await ctx.prove("Structured runtime logs include trace/span IDs and the OTLP log sink emits in the active trace context", {
          voiceover: vo[2],
          action: async () => {
            validation = await getLiveValidation();
            ctx.output("live-otlp-log-evidence", reportSection(validation.report, ["trace", "logs", "assertions"]));
          },
          assert: async () => {
            witness(ctx, validation?.report?.evidence?.logs?.web?.match?.serviceName === "den-web", "Loki stores the den-web proxy completion log");
            witness(ctx, validation?.report?.evidence?.logs?.web?.match?.traceId === validation?.report?.evidence?.trace?.traceId, "The den-web OTLP log trace_id matches the connected Tempo trace");
            witness(ctx, validation?.report?.evidence?.trace?.webSpanIds?.includes(validation?.report?.evidence?.logs?.web?.match?.spanId), "The den-web OTLP log has a span_id belonging to the den-web trace resource");
            witness(ctx, validation?.report?.evidence?.logs?.api?.match?.serviceName === "den-api", "Loki stores the den-api request-completion log");
            witness(ctx, validation?.report?.evidence?.logs?.api?.match?.traceId === validation?.report?.evidence?.trace?.traceId, "The den-api OTLP log trace_id matches the connected Tempo trace");
            witness(ctx, validation?.report?.evidence?.trace?.apiSpanIds?.includes(validation?.report?.evidence?.logs?.api?.match?.spanId), "The den-api OTLP log has a span_id belonging to the den-api trace resource");
            witness(ctx, assertionPassed(validation?.report, "den_web_log_trace_span_matches_trace"), "The validator marks den-web trace/span correlation as observed", reportSection(validation?.report, ["logs"]));
            witness(ctx, assertionPassed(validation?.report, "den_api_log_trace_span_matches_trace"), "The validator marks den-api trace/span correlation as observed", reportSection(validation?.report, ["logs"]));
          },
        });
      },
    },
    {
      name: "Hono metrics and per-signal controls are wired",
      run: async (ctx) => {
        let validation;
        let controls;
        await ctx.prove("Den API uses Hono OTEL request metrics while traces, metrics, and logs can be disabled independently", {
          voiceover: vo[3],
          action: async () => {
            validation = await getLiveValidation();
            ctx.output("live-prometheus-metric-evidence", reportSection(validation.report, ["metrics", "assertions", "runtime"]));
            controls = bunTest(
              ["ee/packages/utils/src/observability.test.ts"],
              "allows disabling individual OTEL signal exporters and configuring ratio sampling",
            );
            ctx.output("per-signal-exporter-controls-test", commandOutput(controls));
          },
          assert: async () => {
            witness(ctx, validation?.report?.evidence?.metrics?.duration?.labels?.service_name === "den-api", "Prometheus stores the duration metric for den-api");
            witness(ctx, validation?.report?.evidence?.metrics?.duration?.labels?.http_route === "/openapi.json", "The Hono duration metric uses the normalized /openapi.json route label");
            witness(ctx, validation?.report?.evidence?.metrics?.duration?.name?.startsWith("http_server_request_duration"), "The observed series is the Hono HTTP server request duration metric");
            witness(ctx, validation?.report?.evidence?.metrics?.active?.labels?.service_name === "den-api", "Prometheus stores the active-request metric series for den-api, even when the current value is zero");
            witness(ctx, validation?.report?.evidence?.metrics?.active?.name?.startsWith("http_server_active_requests"), "The observed active-request series is the Hono HTTP server active-requests metric");
            witness(ctx, assertionPassed(validation?.report, "den_api_hono_active_requests_metric_exists"), "The validator marks the Hono active-request metric series as observed", reportSection(validation?.report, ["metrics"]));
            witness(ctx, commandPassed(controls), "The per-signal exporter control test passes", commandTail(controls));
            witness(ctx, assertionPassed(validation?.report, "no_unhandled_runtime_errors"), "The live den-web and den-api logs contain no unhandled runtime errors", reportSection(validation?.report, ["runtime"]));
          },
        });
      },
    },
    {
      name: "None backend keeps app behavior and uses JSON stdout only",
      run: async (ctx) => {
        let validation;
        let noneTests;
        let noExporter;
        await ctx.prove("With DEN_OBSERVABILITY_BACKEND=none, no exporter initializes and logs remain structured JSON stdout", {
          voiceover: vo[4],
          action: async () => {
            validation = await getLiveValidation();
            ctx.output("live-none-backend-evidence", reportSection(validation.report, ["none", "assertions"]));

            noneTests = bunTest(
              ["ee/packages/utils/src/observability.test.ts", "ee/apps/den-api/test/observability.test.ts"],
              "defaults to disabled observability with an explicit service name|defaults to no provider and rejects unknown backends|writes structured JSON stdout with redaction when no provider is active",
            );
            ctx.output("none-backend-json-stdout-tests", commandOutput(noneTests));

            noExporter = nodeCheck(`
const fs = require("node:fs");
const path = require("node:path");
const runtime = fs.readFileSync(path.join(process.cwd(), "ee/apps/den-api/src/observability/runtime.ts"), "utf8");
const noneCase = runtime.indexOf('case "none"');
const otelCase = runtime.indexOf('case "otel"');
const sentryCase = runtime.indexOf('case "sentry"');
if (noneCase === -1 || otelCase === -1 || sentryCase === -1) throw new Error("backend switch cases missing");
if (!(noneCase < otelCase && noneCase < sentryCase)) throw new Error("none backend is not the first early-return case");
const noneBlock = runtime.slice(noneCase, otelCase);
if (!noneBlock.includes("return state")) throw new Error("none backend does not return before exporter startup");
if (noneBlock.includes("startOtel") || noneBlock.includes("startSentry")) throw new Error("none backend includes exporter startup");
if (!runtime.includes("honoMiddlewares: []")) throw new Error("initial runtime should have no provider middlewares");
console.log("confirmed: none backend returns state before startOtel/startSentry and starts with no provider middlewares");
`);
            ctx.output("none-backend-no-exporter-source-check", commandOutput(noExporter));
          },
          assert: async () => {
            witness(ctx, assertionPassed(validation?.report, "none_backend_http_200"), "The live none-backend proxy request returns HTTP 200", reportSection(validation?.report, ["none"]));
            witness(ctx, assertionPassed(validation?.report, "none_backend_json_stdout_request_logs"), "The live none-backend run emits structured JSON stdout request logs for den-web and den-api", reportSection(validation?.report, ["none"]));
            witness(ctx, assertionPassed(validation?.report, "none_backend_no_exporter_connection_or_error_attempt"), "The live none-backend run shows no exporter connection or error attempt", reportSection(validation?.report, ["none"]));
            witness(ctx, commandPassed(noneTests), "The none-backend and JSON stdout tests pass", commandTail(noneTests));
            witness(ctx, noneTests?.output.includes("3 pass"), "The none-backend command exercised config defaults and JSON stdout redaction", commandTail(noneTests));
            witness(ctx, commandPassed(noExporter), "The none backend source check proves no OTEL/Sentry exporter startup path is entered", commandTail(noExporter));
          },
        });
      },
    },
    {
      name: "Sentry is exclusive and source-map uploads are gated",
      run: async (ctx) => {
        let sentryTests;
        let switchCheck;
        await ctx.prove("Mocked Sentry tests prove backend exclusivity and source-map gating without claiming live Sentry delivery", {
          voiceover: vo[5],
          action: async () => {
            sentryTests = bunTest(
              ["ee/apps/den-web/tests/observability-config.test.ts", "ee/packages/utils/src/observability.test.ts"],
              "selects exactly one runtime initializer|wraps browser Sentry builds without server runtime secrets and disables source-map upload|requires complete Sentry build credentials only when source-map uploads are enabled|wraps source-map uploads only when the build-only upload flag is enabled|parses Sentry runtime config and sanitizes build-only variables",
            );
            ctx.output("sentry-exclusivity-and-sourcemap-tests", commandOutput(sentryTests));
            ctx.output("sentry-proof-scope", "This frame is deterministic unit/source proof only: it does not contact Sentry or claim live event delivery.");

            switchCheck = nodeCheck(`
const fs = require("node:fs");
const path = require("node:path");
const root = process.cwd();
const apiRuntime = fs.readFileSync(path.join(root, "ee/apps/den-api/src/observability/runtime.ts"), "utf8");
const webServer = fs.readFileSync(path.join(root, "ee/apps/den-web/observability/server-config.ts"), "utf8");
const webNext = fs.readFileSync(path.join(root, "ee/apps/den-web/observability/next-config-observability.cjs"), "utf8");
const apiOtelCase = apiRuntime.indexOf('case "otel"');
const apiSentryCase = apiRuntime.indexOf('case "sentry"');
if (apiOtelCase === -1 || apiSentryCase === -1) throw new Error("Den API backend cases missing");
const apiOtelBlock = apiRuntime.slice(apiOtelCase, apiSentryCase);
const apiSentryBlock = apiRuntime.slice(apiSentryCase);
if (!apiOtelBlock.includes("await startOtel(state)") || apiOtelBlock.includes("await startSentry(state)")) throw new Error("Den API OTEL branch is not exclusive");
if (!apiSentryBlock.includes("await startSentry(state)") || apiSentryBlock.includes("await startOtel(state)")) throw new Error("Den API Sentry branch is not exclusive");
for (const [source, needle, label] of [
  [webServer, 'backend === "otel"', "Den web OTEL branch"],
  [webServer, 'backend === "sentry"', "Den web Sentry branch"],
  [webNext, "sourceMapUploadsEnabled", "source-map upload gate"],
  [webNext, "completeSentryBuildCredentials", "build credential gate"],
]) {
  if (!source.includes(needle)) throw new Error(label + " missing (" + needle + ")");
}
console.log("confirmed: api switch chooses one backend; web dispatch chooses one initializer; source-map upload depends on Sentry build credentials");
`);
            ctx.output("sentry-exclusive-source-check", commandOutput(switchCheck));
          },
          assert: async () => {
            witness(ctx, commandPassed(sentryTests), "The Sentry exclusivity and source-map gating tests pass", commandTail(sentryTests));
            witness(ctx, sentryTests?.output.includes("5 pass"), "The Sentry command covered single-initializer dispatch, credential redaction, and source-map upload gating", commandTail(sentryTests));
            witness(ctx, commandPassed(switchCheck), "The source check proves Sentry/OTEL runtime exclusivity and source-map gating branches", commandTail(switchCheck));
          },
        });
      },
    },
  ],
};
