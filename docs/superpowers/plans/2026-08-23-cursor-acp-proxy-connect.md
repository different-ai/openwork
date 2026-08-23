# Cursor ACP Proxy Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Wave 1 launches two implementers in parallel. Never give a subagent this whole file — extract a task brief with `scripts/task-brief`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Future work — do not implement until explicitly asked. This commit is the plan only.

**Goal:** Make OpenWork's managed engine start the local Cursor ACP proxy on `127.0.0.1:32124` so a Cursor API key (env store or Connect modal) can reach Cursor instead of failing with `Cannot connect to API: Unable to connect. Is the computer able to access the url?`

**Architecture:** Split two hermetic helpers so they can land in parallel, then wire them into `withCursorAcpProvider`. `OPENCODE_CONFIG` replaces `~/.config/opencode/opencode.json`. The real Cursor bridge is the local plugin at `<opencode-config-dir>/plugin/cursor-acp.js` (`@rama_nigg/open-cursor`), which binds `127.0.0.1:32124`. That plugin auto-loads, then disables itself unless the runtime config lists a matching plugin spec or defines `provider.cursor-acp`. Commit `6abbf3f0e` injects those blocks only when `process.env.CURSOR_API_KEY` is set; the live runtime file never got them. Helper A reads the OpenWork env store. Helper B resolves the local plugin file path. The wire-up injects the absolute plugin path plus the global provider block so OpenCode loads the real file instead of the unrelated npm `cursor-acp` ACP adapter.

**Tech Stack:** TypeScript, Bun test runner, `EnvService` from `apps/server/src/env-file.ts`, `resolveGlobalOpencodeConfigPath` from `@openwork/paths`.

## Root cause (already verified — do not re-litigate)

Observed 2026-08-23 on this machine:

1. Error text is OpenCode's generic "provider URL unreachable" message. It is not authored in this repo.
2. Nothing listens on `32124`.
3. `C:\Users\Kishan\AppData\Roaming\openwork\runtime-opencode-config.json` plugin list is only OpenWork builtins. No `cursor-acp` plugin, no `provider.cursor-acp`.
4. `C:\Users\Kishan\.opencode-cursor\plugin.log` repeats `disabled_in_plugin_array` against that runtime file (including after the 17:58 rebuilt exe).
5. Local plugin enable check: enabled if `provider["cursor-acp"]` exists OR `plugin` contains `"cursor-acp"` / `@rama_nigg/open-cursor`.
6. `CURSOR_API_KEY` lives in OpenWork `env.json`. `withCursorAcpProvider` only reads `process.env.CURSOR_API_KEY`. `resolveOpenAiRealtimeApiKey` in `apps/server/src/server.ts` already reads `EnvService` first.
7. Desktop injects `env.json` into `process.env` only at embedded-server start. Save-then-Connect without Apply leaves the running process and the already-written runtime file without `cursor-acp`.
8. npm `cursor-acp` is a stdio ACP adapter and does not bind 32124.

Do not "fix" the error string, add retries, or change the Connect UI. Fix injection so the proxy process starts.

## Global Constraints

- pnpm only; TypeScript: no `any`, no typecasts, no `as` unless 100% necessary.
- TDD: write the failing test, watch it fail, then implement. No production code before the red run.
- Wave 1 tasks MUST NOT touch each other's files. No edits to `openwork-runtime-config.ts` in Wave 1.
- When `OPENCODE_CONFIG_DIR` is set, resolve global config and the local plugin only under that directory. Never scan the real `~/.config/opencode` in that case (existing tests isolate via `OPENCODE_CONFIG_DIR`; this machine has a real `plugin/cursor-acp.js` that would flake tests).
- Do not print, log, or commit `CURSOR_API_KEY` values. Tests use the placeholder `cur_test_key`.
- Plugin spec must be an absolute path to `plugin/cursor-acp.js` when that file exists under the resolved OpenCode config dir. Fall back to the string `cursor-acp` only when the file is absent.
- Provider block `baseURL` stays `http://127.0.0.1:32124/v1` (copied from global config, not invented).
- Do not add dependencies.
- Do not rebuild the exe until Task 4.
- Do not implement this plan unless the human asks. This document is future work.

---

## File map

| File | Owner task | Responsibility |
|------|------------|----------------|
| `apps/server/src/cursor-acp-env.ts` | Task 1 | `resolveCursorApiKey` — env store then `process.env` |
| `apps/server/src/cursor-acp-env.test.ts` | Task 1 | Unit tests for key resolution |
| `apps/server/src/cursor-acp-plugin-path.ts` | Task 2 | `resolveLocalCursorAcpPluginPath` — local `plugin/cursor-acp.js` |
| `apps/server/src/cursor-acp-plugin-path.test.ts` | Task 2 | Unit tests for path resolution |
| `apps/server/src/openwork-runtime-config.ts` | Task 3 | Wire helpers into `withCursorAcpProvider` |
| `apps/server/src/openwork-runtime-config.test.ts` | Task 3 | Integration tests through `buildOpenworkRuntimeConfig` |
| `apps/server/src/env-file.ts` | none | Reuse `EnvService` only |

---

## Parallel execution graph

```text
Wave 1 (parallel — no shared files):
  [Task 1: resolveCursorApiKey]     [Task 2: resolveLocalCursorAcpPluginPath]

Wave 2 (sequential — needs both Wave 1 exports):
  Task 3: wire withCursorAcpProvider

Wave 3 (after Task 3 review is clean):
  Task 4: verify suite + package Windows exe + smoke
```

**Subagent dispatch:**

1. Extract briefs with the SDD `task-brief` script. Never paste this whole plan into a subagent.
2. Launch Task 1 and Task 2 in the **same controller turn** as two parallel implementers (`cursor-acp-env`, `cursor-acp-plugin-path`).
3. Models: Task 1 and Task 2 are mechanical 1-file helpers with complete code — cheapest listed implementer tier. Task 3 is integration — standard model. Task 3 and Task 4 reviewers — mid-tier floor. Final whole-branch review — most capable listed model.
4. After each implementer returns DONE, run `scripts/review-package BASE HEAD` (BASE = commit recorded **before** that implementer, never `HEAD~1`) and dispatch the task reviewer with brief + report + package paths.
5. Do not start Task 3 until both Wave 1 reviews are spec ✅ and quality approved.
6. Task 3 implementer may only import the Wave 1 exported names below. If a Wave 1 export does not match, stop and ask — do not rename in Task 3.
7. Ledger: append one line to `.superpowers/sdd/progress.md` when a task review is clean.

**Branch (when implementation is requested):** `fix/cursor-acp-proxy-connect` off current default. Do not create the branch in this future-work commit.

**Report contract (every implementer):** write the full report to the report-file path from the dispatch. Return only: status (`DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED`), commit SHAs, one-line test summary, concerns.

---

### Task 1: `resolveCursorApiKey`

**Files:**
- Create: `apps/server/src/cursor-acp-env.ts`
- Create: `apps/server/src/cursor-acp-env.test.ts`

**Do not touch:** `openwork-runtime-config.ts`, `openwork-runtime-config.test.ts`, `cursor-acp-plugin-path.ts`.

**Interfaces:**
- Consumes: `EnvService` from `./env-file.js` (`new EnvService()` reads `OPENWORK_ENV_STORE` or the default env.json path)
- Produces:
  - `export async function resolveCursorApiKey(envService?: EnvService): Promise<string>`
  - Empty string when neither store nor `process.env` has a non-whitespace key
  - Store wins over `process.env` when both are set

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/cursor-acp-env.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnvService } from "./env-file.js";
import { resolveCursorApiKey } from "./cursor-acp-env.js";

const roots: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length) cleanups.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function isolateProcessKey() {
  const previous = process.env.CURSOR_API_KEY;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previous;
  });
  delete process.env.CURSOR_API_KEY;
}

describe("resolveCursorApiKey", () => {
  test("returns the env-store key when process.env.CURSOR_API_KEY is unset", async () => {
    isolateProcessKey();
    const root = await mkdtemp(join(tmpdir(), "cursor-acp-env-"));
    roots.push(root);
    const env = new EnvService({ path: join(root, "env.json") });
    await env.upsertMany([{ key: "CURSOR_API_KEY", value: "cur_test_key" }]);
    expect(await resolveCursorApiKey(env)).toBe("cur_test_key");
  });

  test("returns process.env.CURSOR_API_KEY when the store has no key", async () => {
    isolateProcessKey();
    process.env.CURSOR_API_KEY = "cur_test_key";
    const root = await mkdtemp(join(tmpdir(), "cursor-acp-env-"));
    roots.push(root);
    const env = new EnvService({ path: join(root, "env.json") });
    expect(await resolveCursorApiKey(env)).toBe("cur_test_key");
  });

  test("prefers the env-store key over process.env", async () => {
    isolateProcessKey();
    process.env.CURSOR_API_KEY = "cur_process_key";
    const root = await mkdtemp(join(tmpdir(), "cursor-acp-env-"));
    roots.push(root);
    const env = new EnvService({ path: join(root, "env.json") });
    await env.upsertMany([{ key: "CURSOR_API_KEY", value: "cur_test_key" }]);
    expect(await resolveCursorApiKey(env)).toBe("cur_test_key");
  });

  test("returns empty string when neither source has a key", async () => {
    isolateProcessKey();
    const root = await mkdtemp(join(tmpdir(), "cursor-acp-env-"));
    roots.push(root);
    const env = new EnvService({ path: join(root, "env.json") });
    expect(await resolveCursorApiKey(env)).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @openwork/server exec bun test src/cursor-acp-env.test.ts
```

Expected: FAIL with `resolveCursorApiKey` not defined / module not found. Not a later assertion failure against a stub that already returns `"cur_test_key"`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/cursor-acp-env.ts`:

```typescript
import { EnvService } from "./env-file.js";

export async function resolveCursorApiKey(envService?: EnvService): Promise<string> {
  try {
    const stored = (await (envService ?? new EnvService()).list())
      .find((entry) => entry.key === "CURSOR_API_KEY")
      ?.value.trim() ?? "";
    if (stored) return stored;
  } catch {
    // Missing or unreadable env store is not a Cursor-key signal.
  }
  return process.env.CURSOR_API_KEY?.trim() ?? "";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter @openwork/server exec bun test src/cursor-acp-env.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/cursor-acp-env.ts apps/server/src/cursor-acp-env.test.ts
git commit -m "feat(server): resolve CURSOR_API_KEY from env store"
```

---

### Task 2: `resolveLocalCursorAcpPluginPath`

**Files:**
- Create: `apps/server/src/cursor-acp-plugin-path.ts`
- Create: `apps/server/src/cursor-acp-plugin-path.test.ts`

**Do not touch:** `openwork-runtime-config.ts`, `openwork-runtime-config.test.ts`, `cursor-acp-env.ts`.

**Interfaces:**
- Consumes: `resolveGlobalOpencodeConfigPath()` from `@openwork/paths`
- Produces:
  - `export const CURSOR_ACP_PLUGIN_FILENAME = "cursor-acp.js"`
  - `export function resolveLocalCursorAcpPluginPath(): string | null`
  - Path is `join(dirname(resolveGlobalOpencodeConfigPath()), "plugin", CURSOR_ACP_PLUGIN_FILENAME)` when that file exists, else `null`
  - Must not call `homedir()` or read `~/.config/opencode` when `OPENCODE_CONFIG_DIR` is set

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/cursor-acp-plugin-path.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveLocalCursorAcpPluginPath } from "./cursor-acp-plugin-path.js";

const roots: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length) cleanups.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function isolateConfigDir(dir: string) {
  const previous = process.env.OPENCODE_CONFIG_DIR;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  });
  process.env.OPENCODE_CONFIG_DIR = dir;
}

describe("resolveLocalCursorAcpPluginPath", () => {
  test("returns the absolute plugin path when plugin/cursor-acp.js exists under OPENCODE_CONFIG_DIR", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-acp-plugin-"));
    roots.push(dir);
    isolateConfigDir(dir);
    const pluginPath = join(dir, "plugin", "cursor-acp.js");
    await mkdir(join(dir, "plugin"), { recursive: true });
    await writeFile(pluginPath, "export default async () => ({})", "utf8");
    expect(resolveLocalCursorAcpPluginPath()).toBe(pluginPath);
  });

  test("returns null when OPENCODE_CONFIG_DIR has no plugin/cursor-acp.js", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-acp-plugin-"));
    roots.push(dir);
    isolateConfigDir(dir);
    expect(resolveLocalCursorAcpPluginPath()).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @openwork/server exec bun test src/cursor-acp-plugin-path.test.ts
```

Expected: FAIL with `resolveLocalCursorAcpPluginPath` not defined / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/cursor-acp-plugin-path.ts`:

```typescript
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveGlobalOpencodeConfigPath } from "@openwork/paths";

export const CURSOR_ACP_PLUGIN_FILENAME = "cursor-acp.js";

export function resolveLocalCursorAcpPluginPath(): string | null {
  const pluginPath = join(dirname(resolveGlobalOpencodeConfigPath()), "plugin", CURSOR_ACP_PLUGIN_FILENAME);
  return existsSync(pluginPath) ? pluginPath : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter @openwork/server exec bun test src/cursor-acp-plugin-path.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/cursor-acp-plugin-path.ts apps/server/src/cursor-acp-plugin-path.test.ts
git commit -m "feat(server): resolve local cursor-acp plugin path"
```

---

### Task 3: Wire helpers into `withCursorAcpProvider`

**Files:**
- Modify: `apps/server/src/openwork-runtime-config.ts`
- Modify: `apps/server/src/openwork-runtime-config.test.ts`

**Do not touch:** `cursor-acp-env.ts`, `cursor-acp-plugin-path.ts`, or their tests. Import only.

**Interfaces:**
- Consumes:
  - `resolveCursorApiKey(envService?: EnvService): Promise<string>` from `./cursor-acp-env.js`
  - `resolveLocalCursorAcpPluginPath(): string | null` from `./cursor-acp-plugin-path.js`
- Produces: `withCursorAcpProvider` injects when `resolveCursorApiKey()` is non-empty OR a local plugin file exists OR runtime-DB already has `cursor-acp`. Plugin list entry is the absolute local path when the file exists, otherwise `"cursor-acp"`. Provider block is runtime-DB first, then global config. Do not invent models when a global block exists.

- [ ] **Step 1: Write the failing integration tests**

Add these tests inside the existing `describe("cursor-acp provider injection")` in `apps/server/src/openwork-runtime-config.test.ts`. Reuse `setupCursorAcp`, `buildParsed`, `GLOBAL_CONFIG_WITH_CURSOR_ACP`, `BuiltProvider`. Add `mkdir` to the `node:fs/promises` import.

```typescript
  test("adds cursor-acp from the env store when process.env.CURSOR_API_KEY is unset", async () => {
    const { config } = await setupCursorAcp({ globalConfig: GLOBAL_CONFIG_WITH_CURSOR_ACP });
    const envPath = join(roots[roots.length - 1]!, "env.json");
    const previousStore = process.env.OPENWORK_ENV_STORE;
    cleanups.push(() => {
      if (previousStore === undefined) delete process.env.OPENWORK_ENV_STORE;
      else process.env.OPENWORK_ENV_STORE = previousStore;
    });
    process.env.OPENWORK_ENV_STORE = envPath;
    await new EnvService({ path: envPath }).upsertMany([{ key: "CURSOR_API_KEY", value: "cur_test_key" }]);

    const parsed = await buildParsed(config);
    expect(parsed.plugin).toContain("cursor-acp");
    const provider = parsed.provider as BuiltProvider;
    expect(provider["cursor-acp"]?.options?.baseURL).toBe("http://127.0.0.1:32124/v1");
  });

  test("injects the absolute local plugin path when plugin/cursor-acp.js exists", async () => {
    const { config } = await setupCursorAcp({
      cursorApiKey: "cur_test_key",
      globalConfig: GLOBAL_CONFIG_WITH_CURSOR_ACP,
    });
    const pluginPath = join(process.env.OPENCODE_CONFIG_DIR!, "plugin", "cursor-acp.js");
    await mkdir(join(process.env.OPENCODE_CONFIG_DIR!, "plugin"), { recursive: true });
    await writeFile(pluginPath, "export default async () => ({})", "utf8");

    const parsed = await buildParsed(config);
    expect(parsed.plugin).toContain(pluginPath);
    expect((parsed.plugin as string[]).filter((name) => name === "cursor-acp")).toEqual([]);
    const provider = parsed.provider as BuiltProvider;
    expect(provider["cursor-acp"]?.options?.baseURL).toBe("http://127.0.0.1:32124/v1");
  });

  test("injects cursor-acp from a local plugin file even when CURSOR_API_KEY is unset", async () => {
    const { config } = await setupCursorAcp({ globalConfig: GLOBAL_CONFIG_WITH_CURSOR_ACP });
    const pluginPath = join(process.env.OPENCODE_CONFIG_DIR!, "plugin", "cursor-acp.js");
    await mkdir(join(process.env.OPENCODE_CONFIG_DIR!, "plugin"), { recursive: true });
    await writeFile(pluginPath, "export default async () => ({})", "utf8");

    const parsed = await buildParsed(config);
    expect(parsed.plugin).toContain(pluginPath);
    const provider = parsed.provider as BuiltProvider;
    expect(provider["cursor-acp"]?.name).toBe("Cursor");
  });
```

Add at the top of the test file:

```typescript
import { EnvService } from "./env-file.js";
```

Keep the existing test `leaves cursor-acp out when CURSOR_API_KEY is not set` — that case has no local plugin file and no env-store key, so it must stay green.

- [ ] **Step 2: Run the new tests to verify they fail**

Run:

```bash
pnpm --filter @openwork/server exec bun test src/openwork-runtime-config.test.ts
```

Expected: FAIL on the three new tests. Env-store test fails because `withCursorAcpProvider` still gates on `process.env` only. Path tests fail because the plugin list still uses the bare name `"cursor-acp"` and still requires a process env key.

- [ ] **Step 3: Write minimal wiring**

In `apps/server/src/openwork-runtime-config.ts`:

1. Import:

```typescript
import { resolveCursorApiKey } from "./cursor-acp-env.js";
import { resolveLocalCursorAcpPluginPath } from "./cursor-acp-plugin-path.js";
```

2. Replace `withCursorAcpProvider` with:

```typescript
async function withCursorAcpProvider(runtimeConfig: RuntimeOpencodeConfig): Promise<RuntimeOpencodeConfig> {
  const providers = runtimeProviderMap(runtimeConfig);
  const localPluginPath = resolveLocalCursorAcpPluginPath();
  const hasKey = Boolean(await resolveCursorApiKey());
  if (!hasKey && !localPluginPath && !providers[CURSOR_ACP_PROVIDER_ID]) return runtimeConfig;
  const block = providers[CURSOR_ACP_PROVIDER_ID] ?? (await readGlobalCursorAcpProvider());
  if (!block) return runtimeConfig;
  const pluginSpec = localPluginPath ?? CURSOR_ACP_PROVIDER_ID;
  return {
    ...runtimeConfig,
    plugin: [
      ...runtimePluginList(runtimeConfig).filter((name) => name !== CURSOR_ACP_PROVIDER_ID && name !== pluginSpec),
      pluginSpec,
    ],
    provider: { ...providers, [CURSOR_ACP_PROVIDER_ID]: block },
  };
}
```

Do not inline key or path resolution. Do not add a `homedir()` fallback.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter @openwork/server exec bun test src/openwork-runtime-config.test.ts src/cursor-acp-env.test.ts src/cursor-acp-plugin-path.test.ts
```

Expected: PASS. Confirm `leaves cursor-acp out when CURSOR_API_KEY is not set` still passes.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/openwork-runtime-config.ts apps/server/src/openwork-runtime-config.test.ts
git commit -m "fix(server): inject local cursor-acp plugin so the 32124 proxy starts"
```

---

### Task 4: Verify suite + rebuild the Windows exe

**Files:**
- No new production files
- Rebuild: `apps/desktop/dist-electron/openwork-win-x64-0.0.0-dev.exe`

**Interfaces:**
- Consumes: Task 1 + Task 2 + Task 3 commits
- Produces: rebuilt exe; after one launch, live `runtime-opencode-config.json` must list the local plugin path or `cursor-acp` and `provider.cursor-acp`

- [ ] **Step 1: Run the three test files (fresh)**

```bash
pnpm --filter @openwork/server exec bun test src/openwork-runtime-config.test.ts src/cursor-acp-env.test.ts src/cursor-acp-plugin-path.test.ts
```

Expected: PASS, 0 failures.

- [ ] **Step 2: Rebuild the exe**

Run from repo root:

```bash
pnpm --filter @openwork/desktop run package:electron:dir
```

Expected: `apps/desktop/dist-electron/win-unpacked/OpenWork.exe` and `apps/desktop/dist-electron/openwork-win-x64-0.0.0-dev.exe` get a new `LastWriteTime`.

- [ ] **Step 3: Manual smoke (required — this is the original symptom)**

1. Quit any running OpenWork.
2. Launch the new exe.
3. Confirm `C:\Users\Kishan\AppData\Roaming\openwork\runtime-opencode-config.json` contains `provider.cursor-acp` and a plugin entry that is either `C:\Users\Kishan\.config\opencode\plugin\cursor-acp.js` or `cursor-acp`.
4. Confirm `C:\Users\Kishan\.opencode-cursor\plugin.log` has a new line with `Tool loop mode configured` or `Proxy server started`, not `disabled_in_plugin_array`.
5. Confirm port `32124` listens (`Get-NetTCPConnection -LocalPort 32124`).
6. In Settings → AI, connect with the existing Cursor key. The previous error must not appear.

If step 3.3 is missing `cursor-acp` after launch, stop and re-open Task 3. Do not add a fifth unrelated patch.

- [ ] **Step 4: Commit only if the rebuild produced tracked artifacts the repo expects**

Do not commit `dist-electron` binaries unless this repo already tracks them. If they are gitignored, skip commit.

---

## Self-review

**Spec coverage**

| Requirement | Task |
|-------------|------|
| Env-store `CURSOR_API_KEY` resolves without `process.env` | Task 1 |
| Local `plugin/cursor-acp.js` path is hermetic under `OPENCODE_CONFIG_DIR` | Task 2 |
| Runtime config injects env-store key | Task 3 |
| Runtime config injects absolute local plugin path | Task 3 |
| Plugin enable check sees `provider.cursor-acp` and/or a matching plugin spec | Task 3 |
| Connect works after rebuild (proxy listening) | Task 4 |
| Wave 1 tasks share no files | File map |

**Placeholder scan:** none. Commands, files, and code are complete.

**Type consistency:** `resolveCursorApiKey(envService?: EnvService): Promise<string>`. `resolveLocalCursorAcpPluginPath(): string | null`. `CURSOR_ACP_PLUGIN_FILENAME` is `"cursor-acp.js"`. `CURSOR_ACP_PROVIDER_ID` stays `"cursor-acp"`. `withCursorAcpProvider` still returns `Promise<RuntimeOpencodeConfig>`.

**Parallel-safety:** Task 1 and Task 2 create disjoint files. Task 3 is the only writer of `openwork-runtime-config.ts`. Controller must not start Task 3 until both Wave 1 reviews are clean.
