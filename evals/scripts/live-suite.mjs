import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function reportPassed(report) {
  return report.success === true && Number.isInteger(report.numTotalTests) && report.numTotalTests > 0
    && report.numPendingTests === 0 && report.numTodoTests === 0
    && report.numPassedTests === report.numTotalTests;
}

function main() {

  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const required = ["OPENWORK_EVAL_LIVE_DEN_API_URL", "OPENWORK_EVAL_LIVE_DEN_WEB_URL", "AGENTMAIL_API_KEY", "OPENWORK_EVAL_LIVE_STRIPE_SECRET_KEY", "OPENWORK_EVAL_LIVE_ADMIN_TOKEN"];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (process.env.OPENWORK_EVAL_LIVE !== "1") missing.unshift("OPENWORK_EVAL_LIVE=1");
  if (missing.length) {
    console.error(`Incomplete — missing live requirements: ${missing.join(", ")}`);
    process.exit(1);
  }
  mkdirSync(`${cwd}/results/live`, { recursive: true });
  console.error("placement: attached (live HTTPS deployment; fresh local Chrome via CDP)");
  const result = spawnSync("pnpm", ["exec", "vitest", "run", "--project", "live",
    "--reporter=default", "--reporter=json", "--reporter=junit",
    "--outputFile.json=results/live/results.json", "--outputFile.junit=results/live/junit.xml"], {
    cwd, stdio: "inherit", env: { ...process.env, OPENWORK_EVAL_E2E_TESTS: "1", OPENWORK_EVAL_DAYTONA: "0" },
  });
  if (result.error || result.status !== 0) {
    console.error("Failed — live suite did not complete successfully.");
    process.exit(result.status ?? 1);
  }
  const report = JSON.parse(readFileSync(`${cwd}/results/live/results.json`, "utf8"));
  if (!reportPassed(report)) {
    console.error("Incomplete — live suite must execute every discovered test without skips.");
    process.exit(1);
  }
  console.log(`Passed — ${report.numPassedTests} live tests, zero skipped.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
