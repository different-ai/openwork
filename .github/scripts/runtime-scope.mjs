#!/usr/bin/env node
// The docs refresh waits for a deployment input commit, not an unrelated dev
// commit that Render's build filter intentionally never deploys.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInputPatterns } from "./build-inputs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function apiDeploymentCommit({ root = ROOT, ref = "HEAD" } = {}) {
  const git = (args) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  // Git treats a shallow boundary as a root that introduced every path. It is
  // not evidence of an API change and could name a commit Render never deploys.
  if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
    throw new Error("Complete API deployment history is unavailable");
  }
  const patterns = buildInputPatterns("native-den-api", { root, ref });
  const commit = git([
    "log", "--first-parent", "-1", "--format=%H", ref, "--",
    ...patterns.map((pattern) => `:(glob)${pattern}`),
  ]);
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("API deployment input commit is unavailable");
  return commit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const commit = apiDeploymentCommit({ ref: process.argv[2] ?? "HEAD" });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `deployment_sha=${commit}\n`);
    console.log(`API deployment input commit: ${commit}`);
  } catch (error) {
    // The workflow falls back to the pushed SHA and refreshes on any error.
    console.error(error.message);
    process.exitCode = 1;
  }
}
