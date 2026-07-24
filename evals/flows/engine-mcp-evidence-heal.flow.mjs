/**
 * Internal proof that stale engine-MCP failure evidence heals when live engine
 * status shows the managed cloud connection is already connected.
 *
 * The orchestrator supplies OPENWORK_EVAL_REPRO_COMMAND. That command runs the
 * real repro driver on the target environment and prints its final JSON as the
 * last stdout line.
 */
import { spawnSync } from "node:child_process";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "engine-mcp-evidence-heal";
const DEFAULT_REPRO_TIMEOUT_MS = 300_000;
const REQUIRED_ENV = ["OPENWORK_EVAL_REPRO_COMMAND"];

const vo = await loadVoiceoverParagraphs(FLOW_ID);

const state = {
  evidence: null,
  reproRun: null,
};

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value, key) {
  if (!isRecord(value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function compactActual(actual) {
  if (actual === undefined) return undefined;
  if (typeof actual === "string") return actual.slice(0, 1_200);
  try {
    return JSON.stringify(actual).slice(0, 1_200);
  } catch {
    return String(actual).slice(0, 1_200);
  }
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: compactActual(actual),
  });
  ctx.assert(condition, assertion + (actual === undefined ? "" : ` (actual: ${compactActual(actual)})`));
}

function textTail(value, max = 4_000) {
  const text = String(value ?? "").trimEnd();
  return text.length > max ? text.slice(-max) : text;
}

function parseTimeoutMs() {
  const raw = process.env.OPENWORK_EVAL_REPRO_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_REPRO_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`OPENWORK_EVAL_REPRO_TIMEOUT_MS must be a positive number of milliseconds (got ${raw}).`);
  }
  return Math.round(value);
}

function readEvalEnv() {
  const values = {};
  const missing = [];
  for (const name of REQUIRED_ENV) {
    const value = process.env[name]?.trim() ?? "";
    if (!value) missing.push(name);
    values[name] = value;
  }
  return { values, missing };
}

function requiredEnv() {
  const snapshot = readEvalEnv();
  if (snapshot.missing.length > 0) {
    throw new Error(
      `Missing required environment variables for ${FLOW_ID}: ${snapshot.missing.join(", ")}. `
      + "Set OPENWORK_EVAL_REPRO_COMMAND to a shell command that runs scripts/repro-engine-mcp-evidence.mjs on the target environment and prints the driver's final JSON as the last stdout line.",
    );
  }
  return { command: snapshot.values.OPENWORK_EVAL_REPRO_COMMAND, timeoutMs: parseTimeoutMs() };
}

function parseLastStdoutJson(stdout, stderr) {
  const trimmed = String(stdout ?? "").trimEnd();
  if (!trimmed) {
    throw new Error(`Repro command produced no stdout JSON. Stderr tail:\n${textTail(stderr)}`);
  }
  const lines = trimmed.split(/\r?\n/);
  const lastLine = lines[lines.length - 1]?.trim() ?? "";
  try {
    return JSON.parse(lastLine);
  } catch (error) {
    throw new Error(
      `Could not parse the repro command's last stdout line as JSON: ${error instanceof Error ? error.message : String(error)}\n`
      + `Last stdout line:\n${lastLine.slice(0, 2_000)}\n`
      + `Stderr tail:\n${textTail(stderr)}`,
    );
  }
}

function runReproOnce() {
  if (state.evidence) return;
  const { command, timeoutMs } = requiredEnv();
  const startedAt = Date.now();
  const result = spawnSync(command, {
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  state.reproRun = {
    status: result.status,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    stdoutTail: textTail(result.stdout),
    stderrTail: textTail(result.stderr),
  };
  if (result.error || result.status !== 0) {
    const reason = result.error instanceof Error ? result.error.message : `exit status ${String(result.status)}`;
    throw new Error(`Repro command failed (${reason}). Stderr tail:\n${textTail(result.stderr)}`);
  }
  state.evidence = parseLastStdoutJson(result.stdout, result.stderr);
}

function evidence() {
  if (!state.evidence) throw new Error("Repro evidence was not captured before the frame ran.");
  return state.evidence;
}

function phases() {
  return own(evidence(), "phases");
}

function seedPhase() {
  return own(phases(), "seed");
}

function healedPhase() {
  return own(phases(), "healed");
}

function diagnosticsPhase() {
  return own(phases(), "diagnostics");
}

function proxyHolds() {
  const holds = own(evidence(), "proxyHolds");
  return Array.isArray(holds) ? holds : [];
}

function isHealthConnected(health) {
  return own(health, "usable") === true
    || own(health, "phase") === "ready"
    || own(own(health, "engine"), "status") === "connected";
}

function engineSyncFailed(mcpBody) {
  const sync = own(mcpBody, "engineSync");
  const failures = own(sync, "failures");
  return own(sync, "status") === "failed"
    && Array.isArray(failures)
    && failures.some((failure) => own(failure, "name") === "openwork-cloud");
}

function initialReconcileFailed(reconcile) {
  const firstFailure = own(reconcile, "firstFailure");
  const delivery = own(reconcile, "delivery");
  return own(firstFailure, "code") === "opencode_mcp_sync_failed"
    || own(delivery, "state") === "failed"
    || own(own(delivery, "failure"), "code") === "opencode_mcp_sync_failed";
}

function openworkCloudConnectedStatus(diagnostics) {
  const statuses = own(diagnostics, "openworkCloudSyncStatuses");
  if (!Array.isArray(statuses)) return null;
  return statuses.find((status) => own(status, "name") === "openwork-cloud" && own(status, "source") === "config.remote" && own(status, "syncStatus") === "connected") ?? null;
}

export default {
  id: FLOW_ID,
  title: "Engine-MCP diagnostics heal stale registration evidence without opening a chat",
  kind: "internal",
  requiresApp: false,
  precondition: async () => {
    runReproOnce();
  },
  steps: [
    {
      name: "Frame 1 — The repro seeds the slow first handshake and records the original failure",
      run: async (ctx) => {
        await ctx.prove("The repro run forced the first OpenWork Cloud handshake past the registration window and captured the initial failure evidence", {
          voiceover: vo[0],
          assert: async () => {
            const seed = seedPhase();
            const seedReconcile = own(seed, "reconcile");
            const seedMcp = own(seed, "mcp");
            const holds = proxyHolds();
            ctx.output("seed-evidence-and-proxy-holds", JSON.stringify({
              reproRun: state.reproRun,
              seed,
              proxyHolds: holds,
            }, null, 2));
            witness(ctx, isRecord(seed), "The repro evidence includes phases.seed", seed);
            witness(ctx, holds.length > 0, "The delay proxy recorded at least one held engine-to-Den request", holds);
            witness(ctx, holds.some((hold) => Number(own(hold, "heldMs")) >= 15_000), "At least one proxy hold outlasted the 15 second registration window", holds);
            witness(ctx, initialReconcileFailed(seedReconcile), "The seed reconcile response recorded the initial opencode_mcp_sync_failed failure", {
              firstFailure: own(seedReconcile, "firstFailure"),
              delivery: own(seedReconcile, "delivery"),
            });
            witness(ctx, engineSyncFailed(seedMcp), "The immediate MCP inventory recorded engineSync failed for openwork-cloud", own(seedMcp, "engineSync"));
          },
        });
      },
    },
    {
      name: "Frame 2 — Live engine health heals without a chat",
      run: async (ctx) => {
        await ctx.prove("After the delayed handshake completes, live health shows the managed cloud connection is usable", {
          voiceover: vo[1],
          assert: async () => {
            const healed = healedPhase();
            const health = own(healed, "health");
            ctx.output("healed-health", JSON.stringify(health ?? null, null, 2));
            witness(ctx, isRecord(healed), "The repro evidence includes phases.healed", healed);
            witness(ctx, isHealthConnected(health), "The driver's healed health poll observed a usable or connected OpenWork Cloud MCP", health);
          },
        });
      },
    },
    {
      name: "Frame 3 — Agent-context diagnostics report the healed truth",
      run: async (ctx) => {
        await ctx.prove("Agent-context diagnostics no longer report registration_not_connected for a healthy managed cloud MCP", {
          voiceover: vo[2],
          assert: async () => {
            const diagnostics = diagnosticsPhase();
            const check = own(diagnostics, "engineMcpSyncCheck");
            const details = own(check, "details");
            const staleWarning = own(check, "status") === "warning" && own(check, "code") === "mcp_registration_stale_failure";
            const passed = own(check, "status") === "passed";
            const connectedStatus = openworkCloudConnectedStatus(diagnostics);

            ctx.output("diagnostics-check-and-verdict", JSON.stringify({
              engineMcpSyncCheck: check,
              openworkCloudSyncStatuses: own(diagnostics, "openworkCloudSyncStatuses"),
              firstFailedCheck: own(diagnostics, "firstFailedCheck") ?? null,
              contradictionReproduced: own(evidence(), "contradictionReproduced"),
            }, null, 2));
            witness(ctx, isRecord(diagnostics), "The repro evidence includes phases.diagnostics", diagnostics);
            witness(ctx, passed || staleWarning, "engine-mcp-sync passed, or explicitly downgraded stale failure evidence to a warning", check);
            witness(ctx, own(details, "connectedCount") === 1, "engine-mcp-sync details.connectedCount is 1", details);
            if (staleWarning) {
              witness(ctx, Number(own(details, "failedCount")) > 0, "Stale-warning alternative exposes stale failed registrations instead of a hard failure", details);
            } else {
              witness(ctx, own(details, "failedCount") === 0, "engine-mcp-sync details.failedCount is 0", details);
            }
            witness(ctx, own(details, "engineReachableNow") === true, "engine-mcp-sync details.engineReachableNow is true", details);
            witness(ctx, Boolean(connectedStatus), "openworkCloudSyncStatuses includes config.remote openwork-cloud with syncStatus connected", own(diagnostics, "openworkCloudSyncStatuses"));
            witness(ctx, own(diagnostics, "firstFailedCheck") == null, "firstFailedCheck is null or absent", own(diagnostics, "firstFailedCheck"));
            witness(ctx, own(evidence(), "contradictionReproduced") === false, "The historical healthy-system contradiction is not reproduced", own(evidence(), "contradictionReproduced"));
          },
        });
      },
    },
  ],
};
