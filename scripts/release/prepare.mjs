#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const bump = args.find((argument) => ["patch", "minor", "major"].includes(argument)) ?? "patch";
const invalid = args.filter((argument) => !["patch", "minor", "major", "--", "--dry-run", "--watch"].includes(argument));
const repository = process.env.GITHUB_REPOSITORY ?? "different-ai/openwork";
const workflow = "release-prepare.yml";

if (invalid.length > 0) {
  console.error(`Unknown release argument: ${invalid.join(" ")}`);
  process.exit(2);
}

const command = [
  "workflow", "run", workflow,
  "--repo", repository,
  "--ref", "dev",
  "--field", `bump=${bump}`,
];

console.log(`Preparing a ${bump} release through GitHub Actions.`);
console.log(`gh ${command.join(" ")}`);
if (args.includes("--dry-run")) process.exit(0);

execFileSync("gh", command, { stdio: "inherit" });
console.log(`Dashboard: https://github.com/${repository}/actions/workflows/${workflow}`);

if (args.includes("--watch")) {
  console.log("Waiting for the prepare run to appear...");
  execFileSync("sleep", ["5"]);
  const runId = execFileSync("gh", [
    "run", "list",
    "--repo", repository,
    "--workflow", workflow,
    "--event", "workflow_dispatch",
    "--branch", "dev",
    "--limit", "1",
    "--json", "databaseId",
    "--jq", ".[0].databaseId",
  ], { encoding: "utf8" }).trim();
  if (!runId) throw new Error("Could not resolve the prepare workflow run ID.");
  execFileSync("gh", ["run", "watch", runId, "--repo", repository, "--exit-status"], { stdio: "inherit" });
}
