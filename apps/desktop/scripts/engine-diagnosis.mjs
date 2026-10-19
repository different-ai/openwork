import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * After a failed packaged smoke run: did the app's AI engine (OpenCode) answer?
 *
 * The desktop log records every engine request the OpenWork server proxies, as
 * `GET /workspace/<id>/opencode2/<path> <status> <ms>ms (opencode)`. When the
 * engine never becomes ready, every one of them fails (499 cancelled, 5xx) and
 * the journey fails later with an unrelated-looking browser timeout. This turns
 * the kept logs into one plain sentence, plus the engine's own last errors.
 */
const ENGINE_REQUEST = /^(GET|POST|PUT|PATCH|DELETE) \/workspace\/[^/\s]+\/opencode2(\/\S*)? (\d{3}) (\d+)ms \(opencode\)/;

function logFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return logFiles(path);
    return name.endsWith(".log") ? [path] : [];
  });
}

/** Engine request outcomes in one desktop log. */
export function engineRequests(text) {
  const requests = [];
  for (const line of text.split("\n")) {
    const match = ENGINE_REQUEST.exec(line.trim());
    if (match) requests.push({ method: match[1], path: match[2] ?? "/", status: Number(match[3]), ms: Number(match[4]) });
  }
  return requests;
}

/** The engine never answered when it was asked at least three times and every answer failed. */
export function engineNeverAnswered(requests) {
  return requests.length >= 3 && requests.every((request) => request.status >= 499);
}

/**
 * One finding per desktop whose engine never answered, with the last error lines
 * of that desktop's own engine logs (kept beside it as `<profile>-opencode-*.log`).
 */
export function diagnoseEngine(logsDir) {
  const files = logFiles(logsDir);
  const findings = [];
  for (const file of files.filter((path) => path.endsWith("-electron.log"))) {
    const requests = engineRequests(readFileSync(file, "utf8"));
    if (!engineNeverAnswered(requests)) continue;
    const profile = file.slice(0, -"-electron.log".length);
    const engineErrors = files.filter((path) => path.startsWith(`${profile}-opencode-`))
      .flatMap((path) => readFileSync(path, "utf8").split("\n").filter((line) => /\b(ERROR|WARN|error|failed|timed out)\b/.test(line)))
      .slice(-12);
    const slowest = Math.max(...requests.map((request) => request.ms));
    findings.push({
      log: relative(logsDir, file),
      requests: requests.length,
      statuses: [...new Set(requests.map((request) => request.status))].sort(),
      slowestMs: slowest,
      engineErrors,
    });
  }
  return findings;
}

export function describeEngineFindings(findings) {
  return findings.map((finding) => [
    `The app's AI engine (OpenCode) never answered in ${finding.log}: all ${finding.requests} engine requests failed`
      + ` (HTTP ${finding.statuses.join(", ")}; slowest ${Math.round(finding.slowestMs / 1000)}s).`
      + " Later browser timeouts in this journey are a consequence, not the cause.",
    ...(finding.engineErrors.length
      ? ["Last engine log errors:", ...finding.engineErrors.map((line) => `  ${line.slice(0, 300)}`)]
      : ["No engine log errors were kept; see the uploaded opencode logs, if any."]),
  ].join("\n")).join("\n\n");
}
