#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function git(...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function optionalGit(...args) {
  try {
    return git(...args);
  } catch {
    return "";
  }
}

function read(repoPath) {
  return readFileSync(join(root, repoPath), "utf8");
}

function lines(source) {
  if (!source) return 0;
  return source.endsWith("\n") ? source.split("\n").length - 1 : source.split("\n").length;
}

function repositoryFiles(...areas) {
  const output = execFileSync(
    "git",
    ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...areas],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return output
    .split("\0")
    .filter(Boolean)
    .filter((path) => existsSync(join(root, path)))
    .sort();
}

function repoPath(absolute) {
  return relative(root, absolute).split("\\").join("/");
}

function isTestPath(path) {
  return /(^|\/)(test|tests|__tests__)(\/|$)/.test(path) || /\.(test|spec)\.[^.]+$/.test(path);
}

function isProductImplementation(path) {
  if (!sourceExtensions.has(extname(path))) return false;
  if (isTestPath(path)) return false;
  return !/(^|\/)(evals|scripts)(\/|$)/.test(path);
}

function occurrences(source, pattern) {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)].length;
}

// Measure repository inputs, not generated copies. Including non-ignored
// untracked files keeps the snapshot useful during development while Git's
// ignore rules exclude packaged apps, build output, dependencies, and state.
const allFiles = repositoryFiles("apps", "packages", "ee").map((path) => join(root, path));
const sourceFiles = allFiles.filter((absolute) => sourceExtensions.has(extname(absolute)));
const implementationFiles = sourceFiles.filter((absolute) => isProductImplementation(repoPath(absolute)));
const testFiles = sourceFiles.filter((absolute) => isTestPath(repoPath(absolute)));

const implementationStats = implementationFiles.map((absolute) => {
  const source = readFileSync(absolute, "utf8");
  return { path: repoPath(absolute), lines: lines(source) };
});
const testStats = testFiles.map((absolute) => {
  const source = readFileSync(absolute, "utf8");
  return { path: repoPath(absolute), lines: lines(source) };
});

const packageFiles = repositoryFiles("apps", "packages", "ee/apps", "ee/packages")
  .filter((path) => /^(?:apps|packages|ee\/apps|ee\/packages)\/[^/]+\/package\.json$/.test(path))
  .map((path) => join(root, path));

const packages = packageFiles
  .map((absolute) => {
    const manifest = JSON.parse(readFileSync(absolute, "utf8"));
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    };
    const workspaceDependencies = Object.fromEntries(
      Object.entries(dependencies)
        .filter(([, version]) => typeof version === "string" && version.startsWith("workspace:"))
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    return {
      path: repoPath(absolute),
      name: manifest.name ?? null,
      private: manifest.private === true,
      exports: manifest.exports ?? null,
      files: manifest.files ?? null,
      workspaceDependencies,
    };
  })
  .sort((left, right) => left.path.localeCompare(right.path));

const hotspotPaths = [
  "apps/app/src/react-app/shell/settings-route.tsx",
  "apps/app/src/react-app/domains/settings/state/extensions-store.ts",
  "apps/app/src/react-app/domains/settings/shell/settings-page.tsx",
  "apps/app/src/components/chat/message-list.tsx",
  "apps/app/src/app/extensions.ts",
  "apps/server/src/server.ts",
  "apps/server/src/extensions/index.ts",
  "apps/orchestrator/src/cli.ts",
  "apps/desktop/electron/main.mjs",
  "packages/types/src/desktop-ipc.ts",
  "ee/apps/den-api/src/routes/org/plugin-system/store.ts",
];

const hotspots = hotspotPaths.flatMap((path) => {
  if (!existsSync(join(root, path))) return [];
  const source = read(path);
  return [{
    path,
    lines: lines(source),
    staticImports: occurrences(source, /^import\s/gm),
  }];
});

const registrationPatterns = [
  ["ui-extension-config", /registerExtension(?:Config|Runtime)\s*\(/g],
  ["ui-control-action", /registerAction\s*\(/g],
  ["workspace-reload", /registerWorkspaceReloadControls\s*\(/g],
  ["server-route", /(?:addRoute|register(?:Core|File|Operation|Session|Workspace)Routes)\s*\(/g],
  ["desktop-handler-map", /desktopCommandHandlers\s*=\s*\{/g],
  ["extension-action-list", /OPENWORK_EXPERIMENTAL_EXTENSION_ACTIONS/g],
];

const registrationCounts = Object.fromEntries(registrationPatterns.map(([name]) => [name, 0]));
for (const absolute of sourceFiles) {
  const source = readFileSync(absolute, "utf8");
  for (const [name, pattern] of registrationPatterns) {
    registrationCounts[name] += occurrences(source, pattern);
  }
}

const dependencySignals = [
  ["opencodeSdk", /["']@opencode-ai\/sdk(?:\/[^"']*)?["']/g],
  ["mcpSdk", /["']@modelcontextprotocol\/sdk(?:\/[^"']*)?["']/g],
  ["daytonaSdk", /["']@daytonaio\/sdk(?:\/[^"']*)?["']/g],
  ["drizzleOrm", /["']drizzle-orm(?:\/[^"']*)?["']/g],
];

const dependencyCoupling = Object.fromEntries(dependencySignals.map(([name]) => [name, { sites: 0, files: [] }]));
for (const absolute of implementationFiles) {
  const source = readFileSync(absolute, "utf8");
  for (const [name, pattern] of dependencySignals) {
    const count = occurrences(source, pattern);
    if (!count) continue;
    dependencyCoupling[name].sites += count;
    dependencyCoupling[name].files.push(repoPath(absolute));
  }
}
for (const signal of Object.values(dependencyCoupling)) signal.files.sort();

const appDomainFiles = implementationFiles.filter((absolute) => repoPath(absolute).startsWith("apps/app/src/react-app/domains/"));
const domainToShellEdges = [];
for (const absolute of appDomainFiles) {
  const source = readFileSync(absolute, "utf8");
  const count = occurrences(source, /(?:from\s+|import\s*)["'][^"']*(?:@\/react-app\/shell|react-app\/shell|\.\.\/\.\.\/shell)[^"']*["']/g);
  if (count) domainToShellEdges.push({ path: repoPath(absolute), count });
}

const staleCandidates = [
  "apps/app/src/react-app/kernel/global-sdk-provider.tsx",
  "apps/app/src/react-app/kernel/global-sync-provider.tsx",
  "ee/apps/den-controller/README.md",
  "scripts/dev-web-local.sh",
].map((path) => ({ path, exists: existsSync(join(root, path)) }));

const fraimzFlowFiles = repositoryFiles("evals/flows")
  .filter((path) => path.endsWith(".flow.mjs"))
  .sort();

const largeFileThresholds = [500, 1_000, 2_000, 3_000];
const largeImplementationFiles = Object.fromEntries(
  largeFileThresholds.map((threshold) => [
    `over${threshold}`,
    implementationStats.filter((entry) => entry.lines > threshold).length,
  ]),
);

const result = {
  repository: optionalGit("remote", "get-url", "upstream") || optionalGit("remote", "get-url", "origin"),
  head: git("rev-parse", "HEAD"),
  branch: git("branch", "--show-current") || "DETACHED",
  dirty: git("status", "--porcelain").length > 0,
  totals: {
    workspaces: packages.length,
    workspaceDependencyEdges: packages.reduce(
      (total, manifest) => total + Object.keys(manifest.workspaceDependencies).length,
      0,
    ),
    implementationFiles: implementationStats.length,
    implementationLines: implementationStats.reduce((total, entry) => total + entry.lines, 0),
    testFiles: testStats.length,
    testLines: testStats.reduce((total, entry) => total + entry.lines, 0),
    fraimzFlows: fraimzFlowFiles.length,
  },
  largeImplementationFiles,
  hotspots,
  registrationCounts,
  dependencyCoupling,
  layering: {
    domainToShellEdges: domainToShellEdges.reduce((total, entry) => total + entry.count, 0),
    files: domainToShellEdges,
  },
  staleCandidates,
  packages,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
