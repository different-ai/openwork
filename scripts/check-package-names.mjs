#!/usr/bin/env node
// Workspace package names follow one rule, so a folder tells you its import
// name and related packages sort next to each other:
//
//   apps/<folder>, packages/<folder>         -> @openwork/<folder>
//   ee/apps/<folder>, ee/packages/<folder>   -> @openwork-ee/<folder>
//
// The folder starts with its family and ends with the variant
// (sandbox-daytona, mcp-enterprise-client, gateway-catalog), and never repeats
// "openwork". Packages published under a name that outside tools expect are
// listed in EXCEPTIONS with the reason.
//
// Usage: node scripts/check-package-names.mjs
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const WORKSPACES = [
  { dir: "apps", scope: "@openwork" },
  { dir: "packages", scope: "@openwork" },
  { dir: "ee/apps", scope: "@openwork-ee" },
  { dir: "ee/packages", scope: "@openwork-ee" },
];

/** Folder -> its published name, and why it differs from the rule. */
export const EXCEPTIONS = {
  "apps/review": { name: "@openwork/review-app", reason: "packages/review already owns @openwork/review" },
  "apps/server": { name: "openwork-server", reason: "published to npm and installed by that name" },
  "packages/opencode-plugin": { name: "opencode-openwork", reason: "published to npm; OpenCode plugins are named opencode-*" },
  "packages/openwork-bootstrap": { name: "openwork-bootstrap", reason: "installed by script as the openwork-bootstrap command" },
  "packages/openwork-ui-mcp": { name: "openwork-ui-mcp", reason: "published to npm under this name" },
};

/** The problems with one workspace folder, or an empty list. */
export function packageNameProblems(folder, scope, name) {
  const exception = EXCEPTIONS[folder];
  if (exception) {
    return name === exception.name ? [] : [`${folder} is listed as an exception named ${exception.name}, but its package.json says ${name}`];
  }
  const base = path.posix.basename(folder);
  const problems = [];
  if (name !== `${scope}/${base}`) problems.push(`${folder} is named ${name}; name it ${scope}/${base}, or rename the folder to match`);
  if (base.startsWith("openwork-")) problems.push(`${folder} repeats "openwork"; the scope already says it`);
  return problems;
}

export function checkPackageNames(repoRoot = root) {
  const problems = [];
  for (const { dir, scope } of WORKSPACES) {
    const absolute = path.join(repoRoot, dir);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = path.join(absolute, entry.name, "package.json");
      if (!existsSync(manifest)) continue;
      const { name } = JSON.parse(readFileSync(manifest, "utf8"));
      problems.push(...packageNameProblems(`${dir}/${entry.name}`, scope, name));
    }
  }
  for (const folder of Object.keys(EXCEPTIONS)) {
    if (!existsSync(path.join(repoRoot, folder, "package.json"))) problems.push(`EXCEPTIONS lists ${folder}, which no longer exists; remove it`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkPackageNames();
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  console.log("Workspace package names match their folders.");
}
