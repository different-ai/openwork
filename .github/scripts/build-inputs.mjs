#!/usr/bin/env node
// Build boundaries, not a second workflow engine. Read workspace declarations
// without installing dependencies; retain the few source reads outside that graph.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKSPACES = ["apps", "packages", "ee/apps", "ee/packages"];
const DEPENDENCIES = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const SHARED = [
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "patches/**",
  ".npmrc", ".pnpmfile.cjs", "pnpmfile.cjs", ".nvmrc", ".node-version",
  "tsconfig.declarations.json", "turbo.json", ".github/scripts/build-inputs.mjs",
];
const WORKSPACE_BUILD = "scripts/build-workspace-dependencies.mjs";
const EMBEDDED_DOCS = ["packages/docs/**/*.md", "packages/docs/**/*.mdx", "packages/docs/docs.json"];
const EE_WORKFLOW = ".github/workflows/publish-ee-images.yml";
const EE_SELECTION = ".github/scripts/ee-image*.mjs";
const CI_WORKFLOW = ".github/workflows/ci-tests.yml";
const CONTRACT_SCRIPTS = [
  "scripts/den-contract*.mjs", "scripts/api-lint.mjs", "scripts/features-sync.mjs",
  "scripts/tests/den-contract*.test.mjs", ".spectral.yaml", ".spectral-baseline.json",
];
// app-smoke, the journey the packaged desktop smoke boots, and the evals files
// it imports by relative path (packages it imports are under evals/packages).
// build-inputs.test.mjs recomputes this import closure.
export const APP_SMOKE = [
  "evals/core/app-smoke.e2e.test.ts", "evals/worlds/chat-continuity.ts", "evals/worlds/chat.ts",
  "evals/worlds/desktop-policies.ts", "evals/worlds/first-run.ts", "evals/worlds/library.ts",
  "evals/worlds/openwork-server-cli.ts", "evals/worlds/sessionless-transition.ts", "evals/worlds/signed-in-app-web.ts",
];
const APP_SMOKE_HARNESS = [
  ...APP_SMOKE, "evals/bin/**", "evals/scripts/**", "evals/packages/**",
  "evals/journeys.ts", "evals/config.ts", "evals/package.json", "evals/pnpm-lock.yaml",
  "evals/pnpm-workspace.yaml", "evals/vitest*.ts", "evals/tsconfig*.json",
];
const PACKAGED_SMOKE_CI = [
  CI_WORKFLOW, ".github/scripts/classify-ci-changes.mjs", ".github/actions/setup-tests/**", ".github/actions/setup-browser/**",
];
const snapshots = new Map();

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

function snapshot({ root = ROOT, ref } = {}) {
  root = resolve(root);
  let key;
  if (ref) {
    if (typeof ref !== "string" || ref.startsWith("-")) throw new Error("Invalid build source revision");
    ref = git(root, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
    key = `${root}\0${ref}`;
    if (snapshots.has(key)) return snapshots.get(key);
  }
  let tracked;
  const read = (path) => ref ? git(root, ["show", `${ref}:${path}`]) : readFileSync(join(root, path), "utf8");
  const files = () => tracked ??= ref
    ? git(root, ["ls-tree", "-r", "--name-only", "-z", ref]).split("\0").filter(Boolean)
    : WORKSPACES.flatMap((parent) => existsSync(join(root, parent))
      ? readdirSync(join(root, parent), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(root, parent, entry.name, "package.json")))
        .map((entry) => `${parent}/${entry.name}/package.json`)
      : []);
  const packages = new Map();
  for (const path of files().filter((path) => WORKSPACES.some((parent) => path.startsWith(`${parent}/`) && path.slice(parent.length + 1).split("/").length === 2) && path.endsWith("/package.json"))) {
    const body = JSON.parse(read(path));
    if (!body.name) continue;
    if (packages.has(body.name)) throw new Error(`Duplicate workspace name: ${body.name}`);
    packages.set(body.name, { path: dirname(path), body });
  }
  const closure = (...names) => {
    const seen = new Set();
    const pending = [...names];
    while (pending.length) {
      const name = pending.pop();
      if (seen.has(name)) continue;
      const entry = packages.get(name);
      if (!entry) throw new Error(`Missing workspace input: ${name}`);
      seen.add(name);
      for (const field of DEPENDENCIES) {
        for (const [dependency, version] of Object.entries(entry.body[field] ?? {})) {
          if (packages.has(dependency)) pending.push(dependency);
          else if (version.startsWith("workspace:")) throw new Error(`Missing workspace dependency: ${dependency}`);
        }
      }
    }
    return [...seen].map((name) => `${packages.get(name).path}/**`);
  };
  // Selective Docker COPY sources are real build inputs even when only a
  // manifest is copied. COPY . recipes have a separately tested source closure.
  const copies = (path) => {
    const result = [path, `${path}.dockerignore`, ".dockerignore"];
    for (const line of read(path).split("\n")) {
      if (!/^COPY\s/i.test(line) || /^COPY\s+--from=/i.test(line)) continue;
      const words = line.trim().split(/\s+/).slice(1).filter((word) => !word.startsWith("--"));
      for (const source of words.slice(0, -1)) {
        const clean = source.replace(/^\.\//, "").replace(/\/$/, "");
        if (clean === ".") continue;
        if (/[\[\]"\\]/.test(clean)) throw new Error(`Unsupported COPY input in ${path}`);
        result.push(clean, `${clean}/**`);
      }
    }
    return result;
  };
  const result = { root, read, packages, closure, copies };
  if (key) snapshots.set(key, result);
  return result;
}

/** Repository-relative positive include patterns. These also work as Render buildFilter.paths. */
export function buildInputPatterns(target, options = {}) {
  const source = snapshot(options);
  const { closure, copies } = source;
  const api = () => [...closure("@openwork-ee/den-api"), WORKSPACE_BUILD, "apps/desktop/package.json"];
  const inference = () => [...closure("@openwork-ee/gateway"), WORKSPACE_BUILD];
  const workbot = () => closure("@openwork-ee/workbot");
  const client = () => [
    ...closure("@openwork-ee/den-gateway", "@openwork/app"), WORKSPACE_BUILD,
    "packages/free-auto/**", "apps/server/src/mcp-app-sandbox.ts",
    ...copies("packaging/docker/Dockerfile.den-gateway"),
  ];
  const desktop = () => [
    ...closure("@openwork/desktop", "@openwork/app", "openwork-server"),
    "packages/opencode-plugin/**", "constants.json", WORKSPACE_BUILD, ...EMBEDDED_DOCS,
    "scripts/release/**", ".github/actions/windows-signing/**",
    ".github/workflows/alpha-macos-aarch64.yml", ".github/workflows/build-electron-desktop.yml",
  ];
  const runner = () => [
    ...closure("@openwork-ee/headless-runner"),
    "ee/apps/den-worker-runtime/scripts/cloud-desktop.sh",
    ".github/workflows/celld-runner-deploy.yml",
  ];
  const contract = () => [
    ...api(), ...closure("@openwork/sdk"), ...CONTRACT_SCRIPTS,
    ".github/workflows/api-contract.yml", ".github/workflows/ci-sdk.yml",
    ".github/workflows/refresh-api-docs.yml", CI_WORKFLOW,
  ];
  const render = [".github/scripts/render-build-filters.mjs", ".github/workflows/render-build-filters.yml"];
  let patterns;
  switch (target) {
    case "native-den-api": patterns = [...api(), ...render]; break;
    case "native-inference": patterns = [...inference(), ...render]; break;
    case "native-workbot": patterns = [...workbot(), ...render]; break;
    case "native-client-web": patterns = [...client(), ...render]; break;
    case "den-api": patterns = [...api(), ...copies("packaging/docker/Dockerfile.den"), EE_WORKFLOW, EE_SELECTION]; break;
    case "den-web": patterns = [...closure("@openwork-ee/den-web"), ...copies("packaging/docker/Dockerfile.den-web"), EE_WORKFLOW, EE_SELECTION]; break;
    case "inference": patterns = [...inference(), ...copies("packaging/docker/Dockerfile.gateway"), EE_WORKFLOW, EE_SELECTION]; break;
    case "client-web": patterns = [...client(), ...render, EE_WORKFLOW, EE_SELECTION]; break;
    case "headless-runner": patterns = [...runner(), ...copies("packaging/docker/Dockerfile.headless-runner"), EE_WORKFLOW, EE_SELECTION]; break;
    case "workbot": patterns = [...workbot(), ...copies("packaging/docker/Dockerfile.workbot"), EE_WORKFLOW, EE_SELECTION]; break;
    case "desktop": patterns = desktop(); break;
    // Everything the packaged desktop contains, for dev pushes.
    case "desktop-smoke": patterns = [...desktop(), ...PACKAGED_SMOKE_CI, ...APP_SMOKE_HARNESS]; break;
    // PRs: the desktop shell, its embedded server and engine pins, dependencies
    // (lockfile and manifests via SHARED) and the smoke harness. App UI and
    // shared packages are typechecked and bundled on every PR and packaged on
    // every dev push.
    case "desktop-package": patterns = [
      "apps/desktop/**", "apps/server/**", "packages/opencode-plugin/**", "constants.json", ...EMBEDDED_DOCS,
      ...PACKAGED_SMOKE_CI, ...APP_SMOKE_HARNESS,
    ]; break;
    case "runtime": patterns = [
      ...closure("@openwork/app", "openwork-server"), "packages/opencode-plugin/**", "packages/documents/**",
      "apps/desktop/package.json", "constants.json", WORKSPACE_BUILD,
      ...copies("ee/apps/den-worker-runtime/Dockerfile.daytona-snapshot"),
      "ee/apps/den-worker-runtime/scripts/editor-proxy.mjs", "ee/apps/den-worker-runtime/scripts/cloud-desktop.sh",
      ".dockerignore", "scripts/create-daytona-openwork-snapshot.sh", "scripts/update-daytona-snapshot-pin.mjs",
      "scripts/prune-daytona-dev-snapshots.mjs", ".github/workflows/dev-daytona-snapshot.yml",
    ]; break;
    case "den-contract": case "sdk": patterns = contract(); break;
    // The MySQL-backed Den API tests (ee/apps/den-api/test/api) and the files
    // they read outside the den-api workspace closure.
    case "den-api-tests": patterns = [
      ...api(), ...closure("@openwork-ee/headless-runner"), "evals/packages/labs/**",
      "packaging/helm/openwork-ee/values.schema.json",
      "packaging/docker/docker-compose.web-local.yml", "packaging/docker/docker-compose.ci-mysql.yml",
      CI_WORKFLOW, ".github/scripts/classify-ci-changes.mjs", ".github/actions/setup-tests/**",
    ]; break;
    case "api-docs": patterns = [...api(), ...render, ...CONTRACT_SCRIPTS, ".github/scripts/runtime-scope.mjs", ".github/workflows/refresh-api-docs.yml"]; break;
    case "i18n": patterns = ["apps/app/src/**", "scripts/i18n-audit.mjs", ".github/workflows/ci-i18n.yml"]; break;
    case "docs": patterns = ["packages/docs/**", CI_WORKFLOW, ".github/scripts/classify-ci-changes.mjs"]; break;
    case "models": patterns = ["ee/apps/gateway/src/models/base.json", CI_WORKFLOW, ".github/scripts/classify-ci-changes.mjs"]; break;
    case "review": patterns = [
      ...closure("@openwork/review-app"), "apps/app/src/styles/colors.css",
      ".vercelignore", ".github/workflows/review-app-deploy.yml",
    ]; break;
    case "helm": patterns = [
      "packaging/**", ".devcontainer/**", "scripts/tests/node-runtime-baseline.test.mjs",
      "apps/server/package.json", "apps/desktop/package.json", EE_WORKFLOW, EE_SELECTION,
    ]; break;
    case "swift": return [
      "packages/computer-use/native/**", ".github/codeql/**", ".github/workflows/codeql.yml",
      ".github/workflows/codeql-result-coverage.yml", "scripts/ci/check-codeql-results.mjs",
      "scripts/ci/codeql-config.test.mjs", ".github/scripts/build-inputs.mjs",
    ].sort();
    case "core": patterns = [
      ...[...source.packages.values()]
        .filter(({ path }) => path !== "ee/apps/landing" && path !== "packages/docs")
        .map(({ path }) => `${path}/**`),
      "evals/**", ".github/scripts/**", ".github/actions/setup-tests/**", ".github/actions/setup-browser/**",
      CI_WORKFLOW, "scripts/**", "constants.json", ".devcontainer/**",
      "packaging/docker/docker-compose*.yml",
    ]; break;
    default: throw new Error(`Unknown build target: ${target}`);
  }
  return [...new Set([...SHARED, ...patterns])].sort();
}

/** Null means an incomplete/unknown diff: build, never skip. */
export function isBuildAffected(target, files, options = {}) {
  if (!Array.isArray(files) || files.some((file) => typeof file !== "string" || !file || file.startsWith("/") || file.split("/").includes(".."))) return true;
  const patterns = buildInputPatterns(target, options);
  return files.some((file) => patterns.some((pattern) => matchesGlob(file, pattern)));
}

/** Full pushed range, including both sides of renames/deletions, without GitHub's file cap. */
export function changedFiles({ base, head = "HEAD", root = ROOT } = {}) {
  if (typeof base !== "string" || !base || /^0+$/.test(base) || base.startsWith("-") || typeof head !== "string" || head.startsWith("-")) return null;
  try {
    return git(root, ["diff", "--no-renames", "--name-only", "-z", base, head, "--"]).split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/** Hash only relevant tracked paths, modes and content identities; commit dates/SHA are not inputs. */
export function buildFingerprint(target, { root = ROOT, ref = "HEAD" } = {}) {
  const patterns = buildInputPatterns(target, { root, ref });
  const tree = git(root, ["ls-tree", "-r", "-z", "--full-tree", ref]);
  const hash = createHash("sha256").update("openwork-build-inputs-v1\0").update(JSON.stringify(patterns)).update("\0");
  for (const entry of tree.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\t");
    const path = entry.slice(separator + 1);
    if (patterns.some((pattern) => matchesGlob(path, pattern))) hash.update(entry).update("\0");
  }
  return hash.digest("hex");
}

function cli(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--") || !argv[index + 1]) throw new Error(`Expected --option value: ${argv[index]}`);
    args.set(argv[index].slice(2), argv[++index]);
  }
  const target = args.get("target");
  if (!target) throw new Error("Pass --target <build target>");
  const root = args.get("root") ?? ROOT;
  const head = args.get("head") ?? "HEAD";
  let base = args.get("base");
  if (!base && process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    base = event.before;
  }
  let files = changedFiles({ base, head, root });
  // Checkout is shallow in CI. Fetch just the missing range endpoint there;
  // never alter a developer's shared clone, and never skip on fetch failure.
  if (files === null && base && !/^0+$/.test(base) && process.env.GITHUB_ACTIONS === "true") {
    if (!/^[a-f0-9]{40,64}$/i.test(base)) throw new Error("Push base must be a commit object ID");
    try {
      execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", base], { cwd: root, stdio: "pipe" });
      files = changedFiles({ base, head, root });
    } catch {
      console.warn("Build input comparison unavailable; selecting the target.");
    }
  }
  let affected = true;
  let fingerprint = "";
  try {
    affected = isBuildAffected(target, files, { root, ref: head });
    fingerprint = buildFingerprint(target, { root, ref: head });
  } catch (error) {
    affected = true;
    fingerprint = "";
    console.warn(`Build input selection unavailable; selecting the target: ${error.message}`);
  }
  const output = `affected=${affected}\nfingerprint=${fingerprint}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
