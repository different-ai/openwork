import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBuildAffected } from "./build-inputs.mjs";
import { apiDeploymentCommit } from "./runtime-scope.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const workflow = (name) => read(`.github/workflows/${name}.yml`);

// These checks deliberately inspect the small workflow boundary, without
// installing a YAML parser or starting the builds/services they guard.
function job(source, id) {
  const lines = source.split("\n");
  const start = lines.indexOf(`  ${id}:`);
  assert.notEqual(start, -1, `Missing job ${id}`);
  const next = lines.findIndex((line, index) => index > start && /^  \S/.test(line));
  return lines.slice(start, next === -1 ? undefined : next).join("\n");
}

const scopedBuilds = [
  ["ci-sdk", "sdk", "generated-sdk"],
  ["api-contract", "den-contract", "openapi-snapshot-and-lint"],
  ["dev-daytona-snapshot", "runtime", "publish-daytona-snapshot"],
  ["refresh-api-docs", "api-docs", "refresh"],
];

for (const [name, target, build] of scopedBuilds) {
  test(`${name}: a cheap independent selector gates the expensive job and fails open`, () => {
    const source = workflow(name);
    const scope = job(source, "scope");
    assert.doesNotMatch(scope, /\b(?:pnpm|docker)\b|^    (?:services|needs|environment):/m);
    assert.match(scope, /fetch-depth: 2/);
    assert.match(scope, /node-version: 24\.22\.1/);
    assert.match(scope, /continue-on-error: true/);
    assert.ok(scope.includes(`node .github/scripts/build-inputs.mjs --target ${target} --base "$BASE_SHA" --head "$HEAD_SHA"`));
    assert.match(scope, /BASE_SHA: \$\{\{ github\.event\.before \}\}/);
    assert.match(scope, /HEAD_SHA: \$\{\{ github\.sha \}\}/);
    assert.match(scope, /steps\.inputs\.outcome == 'success' && steps\.inputs\.outputs\.fingerprint != ''/);
    assert.match(scope, /steps\.inputs\.outputs\.affected \|\| 'true'/);
    const consumer = job(source, build);
    assert.match(consumer, /^    needs: scope$/m);
    assert.match(consumer, /if: \$\{\{ !cancelled\(\).*needs\.scope\.outputs\.affected != 'false'/);
    // A static GitHub path list can miss a newly declared workspace dependency
    // before the selector ever gets a chance to inspect it.
    assert.doesNotMatch(source.split("permissions:")[0], /^    paths:/m);
  });
}

test("SDK and API contract keep dependency setup and every generation/audit/lint assertion", () => {
  const sdk = job(workflow("ci-sdk"), "generated-sdk");
  const contract = job(workflow("api-contract"), "openapi-snapshot-and-lint");
  for (const source of [sdk, contract]) {
    assert.match(source, /image: mysql:8\.4/);
    assert.match(source, /DEN_DB_ENCRYPTION_KEY:/);
    const install = source.split("\n").find((line) => line.includes("pnpm install"));
    assert.ok(install.includes("--frozen-lockfile"));
    for (const filter of ["@openwork-ee/den-api...", "@different-ai/openwork-workspace", "@openwork/sdk"]) {
      assert.ok(install.includes(`--filter "${filter}"`), `Missing install filter ${filter}`);
    }
  }
  assert.match(sdk, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(sdk, /run: pnpm sdk:check/);
  assert.match(sdk, /run: pnpm sdk:build/);
  for (const command of [
    "run: pnpm den:contract",
    "run: pnpm --filter @openwork-ee/den-db exec node --conditions=development --import tsx ./node_modules/drizzle-kit/bin.cjs push --force",
    "run: pnpm --filter @openwork-ee/den-api audit:coverage",
    "run: pnpm api:lint --json tmp/spectral-report.json",
  ]) assert.ok(contract.includes(command), `Missing contract check: ${command}`);
  assert.match(contract, /name: den-api-contract/);
  assert.match(contract, /packages\/docs\/openapi\.json/);
  assert.match(contract, /packages\/sdk\/src\/gen\/\*\*\/\*\.ts/);
  assert.match(contract, /if-no-files-found: error/);
  assert.match(contract, /if: \$\{\{ !cancelled\(\) \}\}/);
  assert.match(contract, /if: \$\{\{ always\(\) \}\}/);
  assert.match(contract, /name: spectral-report/);
});

test("runtime pushes cannot evict another selected push, while scheduled/manual HEAD promotion stays intact", () => {
  const source = workflow("dev-daytona-snapshot");
  assert.match(source, /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name == 'push' && github\.sha \|\| 'promotion' \}\}/);
  assert.match(source, /cancel-in-progress: false/);
  assert.doesNotMatch(source, /cancel-in-progress: true/);
  assert.match(source, /cron: "0 3 \* \* \*"/);
  assert.match(source, /workflow_dispatch:/);
  const scope = job(source, "scope");
  assert.equal((scope.match(/if: github\.event_name == 'push'/g) ?? []).length, 3);
  const publish = job(source, "publish-daytona-snapshot");
  assert.match(publish, /github\.event_name != 'push' \|\| needs\.scope\.outputs\.affected != 'false'/);
  assert.match(publish, /concurrency:\n      group: \$\{\{ github\.workflow \}\}-snapshot-\$\{\{ github\.sha \}\}\n      cancel-in-progress: false/);
  assert.match(publish, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(publish, /git rev-parse --short=7 HEAD/);
  assert.match(publish, /snapshot_name="\$\{DAYTONA_SNAPSHOT_NAME_BASE:-openwork\}-dev-\$\{short_sha\}"/);
  assert.match(publish, /steps\.existing\.outputs\.exists != 'true' \|\| inputs\.force == true/);
  assert.match(publish, /\.\/scripts\/create-daytona-openwork-snapshot\.sh "\$\{DAYTONA_SNAPSHOT_NAME\}"/);
  for (const name of ["Promote snapshot to web production pin", "Redeploy Den API to apply production pin"]) {
    const step = publish.slice(publish.indexOf(`- name: ${name}`)).split(/\n      - name:/)[0];
    assert.match(step, /if: .*github\.event_name != 'push'/, name);
  }
  assert.match(publish, /steps\.pin\.outputs\.changed == 'true'/);
  assert.match(publish, /--keep "\$DAYTONA_SNAPSHOT_NAME"/);
  assert.match(publish, /--keep "\$current_pin"/);
  assert.match(publish, /--keep-count 5/);
  assert.match(publish, /--channel release/);
  assert.match(publish, /--keep-count 20/);
  assert.match(publish, /prune skipped: current pin unknown/);
});

test("i18n remains a standalone, dependency-free source audit with a fail-open selector", () => {
  const source = workflow("ci-i18n");
  assert.doesNotMatch(source, /^    (?:needs|services):|\bpnpm\b|\bdocker\b/m);
  assert.match(source, /--target i18n --base "\$BASE_SHA" --head "\$HEAD_SHA"/);
  assert.match(source, /steps\.inputs\.outcome != 'success' \|\| steps\.inputs\.outputs\.fingerprint == '' \|\| steps\.inputs\.outputs\.affected != 'false'/);
  assert.match(source, /run: node scripts\/i18n-audit\.mjs --ci/);
  for (const path of ["apps/app/src/i18n/locales/en.ts", "apps/app/src/react-app/app.tsx", "scripts/i18n-audit.mjs", ".github/workflows/ci-i18n.yml", "package.json", ".nvmrc"]) {
    assert.equal(isBuildAffected("i18n", [path]), true, path);
  }
  for (const path of ["packages/docs/images/screenshot.png", "apps/app/tests/example.test.ts", "apps/server/src/server.ts", "ee/apps/landing/app/page.tsx"]) {
    assert.equal(isBuildAffected("i18n", [path]), false, path);
  }
});

test("runtime/SDK/contract/API-docs inputs exclude unrelated landing, docs and screenshots", () => {
  for (const target of ["runtime", "sdk", "den-contract", "api-docs"]) {
    for (const path of ["ee/apps/landing/app/page.tsx", "packages/docs/images/example.png", "docs/example.md", "reports/example-screenshot.png"]) {
      assert.equal(isBuildAffected(target, [path]), false, `${target}: ${path}`);
    }
    assert.equal(isBuildAffected(target, null), true, `${target}: unknown diff`);
  }
  for (const [target, paths] of [
    ["runtime", ["apps/app/src/react-app/app.tsx", "apps/server/src/server.ts", "packages/types/src/index.ts", "packages/opencode-plugin/src/plugin.ts", "packages/remote-sessions/src/index.ts", "ee/apps/den-worker-runtime/documents-editor-proxy.mjs", "scripts/create-daytona-openwork-snapshot.sh", ".github/workflows/dev-daytona-snapshot.yml"]],
    ["sdk", ["ee/apps/den-api/src/app.ts", "packages/sdk/script/generate.mjs", "scripts/den-contract.mjs", ".github/workflows/ci-sdk.yml"]],
    ["den-contract", ["ee/apps/den-api/src/app.ts", ".spectral.yaml", "scripts/api-lint.mjs", ".github/workflows/api-contract.yml"]],
    ["api-docs", ["ee/apps/den-api/src/app.ts", "scripts/den-contract.mjs", ".github/scripts/runtime-scope.mjs", ".github/workflows/refresh-api-docs.yml"]],
  ]) for (const path of paths) assert.equal(isBuildAffected(target, [path]), true, `${target}: ${path}`);
});

function dockerSources() {
  return read("ee/apps/den-worker-runtime/Dockerfile.daytona-snapshot").split("\n")
    .filter((line) => /^COPY\s/.test(line) && !/^COPY\s+--from=/.test(line))
    .flatMap((line) => line.split(/\s+/).slice(1, -1))
    .map((source) => source.replace(/\/$/, ""));
}

function workspaceClosure(names) {
  const packages = new Map();
  for (const parent of ["apps", "packages", "ee/apps", "ee/packages"]) {
    for (const entry of readdirSync(join(ROOT, parent), { withFileTypes: true })) {
      const path = `${parent}/${entry.name}`;
      if (!entry.isDirectory() || !existsSync(join(ROOT, path, "package.json"))) continue;
      const body = JSON.parse(read(`${path}/package.json`));
      packages.set(body.name, { path, body });
    }
  }
  const selected = new Set();
  const pending = [...names];
  while (pending.length) {
    const name = pending.pop();
    if (selected.has(name)) continue;
    const entry = packages.get(name);
    assert.ok(entry, `Missing workspace ${name}`);
    selected.add(name);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [dependency, version] of Object.entries(entry.body[field] ?? {})) {
        if (packages.has(dependency) || version.startsWith("workspace:")) pending.push(dependency);
      }
    }
  }
  return [...selected].map((name) => packages.get(name).path);
}

test("snapshot COPY retains the app/server dependency closure without copying unrelated workspaces", () => {
  const sources = dockerSources();
  const copied = (path) => sources.some((source) => path === source || path.startsWith(`${source}/`));
  assert.ok(!sources.includes("."), "COPY . invalidates the snapshot for unrelated source changes");
  for (const path of workspaceClosure(["@openwork/app", "openwork-server", "@openwork/documents", "opencode-openwork"])) {
    assert.ok(copied(`${path}/package.json`), `Snapshot is missing workspace ${path}`);
  }
  for (const path of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "constants.json", "tsconfig.declarations.json", "turbo.json", ".nvmrc", ".node-version", ".npmrc", ".pnpmfile.cjs", "pnpmfile.cjs"]) {
    if (existsSync(join(ROOT, path))) assert.ok(copied(path), `Snapshot is missing root configuration ${path}`);
  }
  for (const path of ["apps/desktop/package.json", "packages/opencode-plugin/server.ts", "packages/remote-sessions/src/index.ts", "ee/apps/den-worker-runtime/documents-editor-proxy.mjs"]) {
    assert.ok(copied(path), `Snapshot is missing source-level input ${path}`);
  }
  for (const path of ["ee/apps/landing/app/page.tsx", "packages/docs/docs.json", "docs/example.md", "reports/screenshot.png", "apps/desktop/src/main.ts", "ee/apps/den-api/src/app.ts"]) {
    assert.equal(copied(path), false, `Snapshot copies unrelated source ${path}`);
  }
  for (const path of sources) {
    const input = statSync(join(ROOT, path)).isDirectory() ? `${path}/__copied_input__` : path;
    assert.equal(isBuildAffected("runtime", [input]), true, `Selector misses COPY source ${path}`);
  }

  // The bundled plugin has relative imports outside its workspace manifest.
  const plugin = "packages/opencode-plugin";
  for (const path of readdirSync(join(ROOT, plugin, "src"), { recursive: true })) {
    if (!path.endsWith(".ts") || /\.test\.ts$/.test(path)) continue;
    const file = join(plugin, "src", path);
    for (const match of read(file).matchAll(/(?:from|import\s*\()\s*["'](\.[^"']+)["']/g)) {
      const target = relative(ROOT, resolve(ROOT, dirname(file), match[1]));
      if (target.startsWith(`${plugin}/`)) continue;
      assert.ok(copied(target), `Snapshot misses ${file}'s relative import ${target}`);
      assert.equal(isBuildAffected("runtime", [target]), true, `Selector misses relative import ${target}`);
    }
  }

  const dockerfile = read("ee/apps/den-worker-runtime/Dockerfile.daytona-snapshot");
  for (const assertion of ["ARG RUNTIME_ASSERTS=1", "OpenCode v2 archive integrity mismatch", "OpenCode v2 version mismatch", "openwork-server --version", "opencode --version", "openwork-extensions-preview.js", "openwork-capabilities-knowledge.js", "openwork-office-attachments.js"]) {
    assert.ok(dockerfile.includes(assertion), `Missing runtime assertion: ${assertion}`);
  }
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "runtime-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commit = (message) => {
    git("add", ".");
    git("-c", "user.name=CI fixture", "-c", "user.email=ci@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "--initial-branch=dev");
  write("package.json", '{"private":true}');
  write("ee/apps/den-api/package.json", '{"name":"@openwork-ee/den-api"}');
  write("ee/apps/den-api/src/app.ts", "export const version = 1;\n");
  const initial = commit("initial fixture");
  return { root, git, write, commit, initial };
}

test("API docs wait for an actual API deployment input, not a filtered workflow/docs commit", (t) => {
  const f = fixture(t);
  f.write("packages/docs/example.mdx", "docs only");
  f.commit("docs change");
  f.write(".github/workflows/refresh-api-docs.yml", "name: refreshed workflow\n");
  f.write(".github/scripts/runtime-scope.mjs", "// helper only\n");
  const filtered = f.commit("docs refresh workflow change");
  assert.notEqual(filtered, f.initial);
  assert.equal(apiDeploymentCommit({ root: f.root }), f.initial);
  f.write("ee/apps/den-api/src/app.ts", "export const version = 2;\n");
  const api = f.commit("API change");
  f.write("ee/apps/landing/app/page.tsx", "landing only");
  f.commit("landing change");
  assert.equal(apiDeploymentCommit({ root: f.root }), api);
  f.write("ee/apps/den-api/src/app.ts", "export const version = 1;\n");
  const revert = f.commit("revert API change");
  assert.equal(apiDeploymentCommit({ root: f.root }), revert);
  assert.throws(() => apiDeploymentCommit({ root: f.root, ref: "missing-ref" }));
});

test("API docs reject a shallow false baseline and can read filtered deployment history", (t) => {
  const f = fixture(t);
  f.write("packages/docs/example.mdx", "docs only");
  const head = f.commit("docs change");
  f.git("config", "uploadpack.allowFilter", "true");
  const clone = join(f.root, "shallow");
  f.git("clone", "--depth=1", pathToFileURL(f.root).href, clone);
  assert.throws(() => apiDeploymentCommit({ root: clone }), /Complete API deployment history is unavailable/);
  execFileSync("git", ["fetch", "--no-tags", "--filter=blob:none", "--unshallow", "origin", head], {
    cwd: clone, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(apiDeploymentCommit({ root: clone }), f.initial);
  assert.equal(f.git("rev-parse", "--is-shallow-repository"), "false", "The source clone's history is untouched");
});

test("API docs use dynamic transitive workspace deployment inputs", (t) => {
  const f = fixture(t);
  f.write("packages/shared/package.json", '{"name":"@fixture/shared"}');
  f.write("packages/shared/src/index.ts", "export const shared = 1;\n");
  f.write("ee/apps/den-api/package.json", '{"name":"@openwork-ee/den-api","dependencies":{"@fixture/shared":"workspace:*"}}');
  f.commit("declare shared input");
  f.write("packages/shared/src/index.ts", "export const shared = 2;\n");
  const shared = f.commit("shared API input change");
  f.write("packages/docs/example.mdx", "docs only");
  f.commit("docs change");
  assert.equal(apiDeploymentCommit({ root: f.root }), shared);
});

test("API docs resolve a dev merge commit, not the undeployed topic branch commit", (t) => {
  const f = fixture(t);
  f.git("checkout", "-b", "topic");
  f.write("ee/apps/den-api/src/app.ts", "export const version = 2;\n");
  f.commit("topic API change");
  f.git("checkout", "dev");
  f.write("packages/docs/example.mdx", "docs only");
  f.commit("dev docs change");
  f.git("-c", "user.name=CI fixture", "-c", "user.email=ci@example.invalid", "-c", "commit.gpgsign=false", "merge", "--no-ff", "topic", "-m", "merge fixture");
  assert.equal(apiDeploymentCommit({ root: f.root }), f.git("rev-parse", "HEAD"));
});

test("out-of-order selectors cannot cancel a newer refresh, which waits for the fail-open deployment target", () => {
  const source = workflow("refresh-api-docs");
  assert.doesNotMatch(source.split("jobs:")[0], /^concurrency:/m);
  assert.match(job(source, "refresh"), /concurrency:\n      group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.sha \}\}\n      cancel-in-progress: false/);
  assert.match(job(source, "scope"), /run: node \.github\/scripts\/runtime-scope\.mjs "\$HEAD_SHA"/);
  assert.match(job(source, "scope"), /if: steps\.inputs\.outcome != 'success' \|\| steps\.inputs\.outputs\.fingerprint == '' \|\| steps\.inputs\.outputs\.affected != 'false'/);
  assert.match(job(source, "scope"), /git fetch --no-tags --filter=blob:none --unshallow origin "\$HEAD_SHA"/);
  assert.match(job(source, "scope"), /if: steps\.history\.outcome == 'success'/);
  assert.match(job(source, "refresh"), /DEPLOYMENT_SHA: \$\{\{ needs\.scope\.outputs\.deployment_sha \|\| github\.sha \}\}/);
  assert.ok(source.includes('compare/$DEPLOYMENT_SHA...${version#commit }'));
  assert.match(source, /matches.*-ge 3/);
  assert.match(source, /SECONDS \+ 30 \* 60/);
  assert.match(source, /MINTLIFY_API_KEY: \$\{\{ secrets\.MINTLIFY_API_KEY \}\}/);
  assert.match(source, /https:\/\/api\.mintlify\.com\/v1\/project\/update\//);
});
