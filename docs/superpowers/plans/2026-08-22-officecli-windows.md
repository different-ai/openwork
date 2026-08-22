# OfficeCLI Windows Auto-MCP + Packaged EXE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a packaged Windows OpenWork `.exe` that auto-registers the user-installed OfficeCLI binary as a local MCP server with zero manual Settings setup.

**Architecture:** Add `apps/server/src/officecli-mcp.ts` to resolve `officecli.exe`, reconcile a managed `mcp.officecli` entry per workspace at server startup and workspace creation, and record user opt-out when a managed entry is deleted. Extend `apps/desktop/electron/runtime.mjs` so GUI-launched processes inherit `%LOCALAPPDATA%\OfficeCLI` on PATH. Package with `electron-builder` after tests pass.

**Tech Stack:** TypeScript (Bun test runner), Node `fs`/`path`, OpenWork server runtime KV + OpenCode runtime config store, Electron `runtime.mjs`, electron-builder NSIS.

**Status:** Future work — spec at `docs/superpowers/specs/2026-08-22-officecli-windows-design.md`

## Global Constraints

- Windows v1 only; non-Windows platforms no-op.
- OfficeCLI is user-installed at `%LOCALAPPDATA%\OfficeCLI\officecli.exe`; not bundled in the installer.
- MCP `command` must use an absolute path to `officecli.exe` plus `"mcp"`.
- Managed entries carry `openworkManaged: true`; never modify user-owned entries without that flag.
- `officecliProvision: "removed"` in openwork workspace config blocks auto-re-add.
- Preserve `enabled: false` when updating managed entries.
- `OPENWORK_OFFICECLI_PATH` env override wins over auto-detect.
- Reconcile failures must not block server startup (warn log only).
- pnpm only; TypeScript: no `any`, no `as` unless unavoidable.
- Every behavior change needs a failing test first (TDD); verify red → green before claiming pass.

---

## File map

| File | Responsibility |
|------|----------------|
| `apps/server/src/officecli-mcp.ts` | Binary resolve, provision state, reconcile |
| `apps/server/src/officecli-mcp.test.ts` | Unit tests (Bun) |
| `apps/server/src/server.ts` | Startup reconcile hook |
| `apps/server/src/routes/workspaces.ts` | Reconcile on workspace create |
| `apps/server/src/server.ts` (DELETE mcp route) | Opt-out on managed delete |
| `apps/desktop/electron/runtime.mjs` | PATH candidate helper + `extraPathEntries` |
| `apps/desktop/electron/runtime.test.mjs` | PATH unit test |

## Parallel execution graph

```text
Wave 1 (parallel — no shared files):
  [Task 1: resolveOfficeCliBinary]     [Task 5: desktop PATH enrichment]

Wave 2 (sequential — depends on Task 1 exports):
  Task 2 → Task 3 → Task 4

Wave 3 (depends on Task 3):
  Task 6: delete opt-out hook

Wave 4 (integration — after Waves 1–3 merged):
  Task 7: full test suite + package Windows exe + manual smoke
```

**Subagent dispatch:** Launch Wave 1 as two parallel subagents (`officecli-resolve`, `desktop-path`). Merge, then run Wave 2 in one subagent (or Task 2→3→4 sequentially). Wave 3 can start when Task 3 lands. Wave 4 is a single integration subagent.

**Branch:** `feat/officecli-windows-auto-mcp` off `dev`.

---

### Task 1: `resolveOfficeCliBinary`

**Files:**
- Create: `apps/server/src/officecli-mcp.ts`
- Create: `apps/server/src/officecli-mcp.test.ts`

**Interfaces:**
- Produces:
  - `export const OFFICECLI_MCP_NAME = "officecli" as const`
  - `export function resolveOfficeCliBinary(env?: NodeJS.ProcessEnv): string | null`

- [ ] **Step 1: Create branch**

```bash
git checkout dev
git pull origin dev
git checkout -b feat/officecli-windows-auto-mcp
```

- [ ] **Step 2: Write failing tests**

Create `apps/server/src/officecli-mcp.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveOfficeCliBinary } from "./officecli-mcp.js";

const previousPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: previousPlatform });
});

describe("resolveOfficeCliBinary", () => {
  test("returns OPENWORK_OFFICECLI_PATH when the file exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "officecli-resolve-"));
    const binary = join(root, "officecli.exe");
    await writeFile(binary, "");
    try {
      const resolved = resolveOfficeCliBinary({
        OPENWORK_OFFICECLI_PATH: binary,
        LOCALAPPDATA: join(root, "unused"),
        PATH: "",
      });
      expect(resolved).toBe(binary);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns default LOCALAPPDATA install path on win32", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const root = await mkdtemp(join(tmpdir(), "officecli-localappdata-"));
    const officeCliDir = join(root, "OfficeCLI");
    const binary = join(officeCliDir, "officecli.exe");
    await mkdir(officeCliDir, { recursive: true });
    await writeFile(binary, "");
    try {
      const resolved = resolveOfficeCliBinary({
        LOCALAPPDATA: root,
        PATH: "",
      });
      expect(resolved).toBe(binary);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns null on non-windows when override is unset", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(resolveOfficeCliBinary({ LOCALAPPDATA: "/tmp", PATH: "/usr/bin" })).toBeNull();
  });

  test("returns null when no candidate exists", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(resolveOfficeCliBinary({ LOCALAPPDATA: "C:\\missing", PATH: "" })).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests — verify RED**

```bash
pnpm --dir apps/server exec bun test src/officecli-mcp.test.ts
```

Expected: FAIL — `Cannot find module './officecli-mcp.js'` or `resolveOfficeCliBinary is not a function`.

- [ ] **Step 4: Minimal implementation**

Create `apps/server/src/officecli-mcp.ts`:

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";

export const OFFICECLI_MCP_NAME = "officecli" as const;

const OFFICECLI_EXE = "officecli.exe";

function normalizedOverride(env: NodeJS.ProcessEnv): string | null {
  const raw = env.OPENWORK_OFFICECLI_PATH?.trim();
  if (!raw) return null;
  return existsSync(raw) ? raw : null;
}

function defaultWindowsInstallPath(env: NodeJS.ProcessEnv): string | null {
  const localAppData = env.LOCALAPPDATA?.trim();
  if (!localAppData) return null;
  const candidate = join(localAppData, "OfficeCLI", OFFICECLI_EXE);
  return existsSync(candidate) ? candidate : null;
}

function pathScan(env: NodeJS.ProcessEnv): string | null {
  const delimiter = process.platform === "win32" ? ";" : ":";
  for (const entry of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(entry, OFFICECLI_EXE);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveOfficeCliBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = normalizedOverride(env);
  if (override) return override;
  if (process.platform !== "win32") return null;
  return defaultWindowsInstallPath(env) ?? pathScan(env);
}
```

- [ ] **Step 5: Run tests — verify GREEN**

```bash
pnpm --dir apps/server exec bun test src/officecli-mcp.test.ts
```

Expected: 4 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/officecli-mcp.ts apps/server/src/officecli-mcp.test.ts
git commit -m "feat(server): resolve OfficeCLI binary on Windows"
```

---

### Task 2: Provision state helpers

**Files:**
- Modify: `apps/server/src/officecli-mcp.ts`
- Modify: `apps/server/src/officecli-mcp.test.ts`

**Interfaces:**
- Consumes: `readOpenworkWorkspaceConfig`, `writeOpenworkWorkspaceConfig` from `./openwork-workspace-config-store.js`
- Produces:
  - `export type OfficeCliProvisionState = "managed" | "removed"`
  - `export async function readOfficeCliProvisionState(config: ServerConfig, workspaceId: string): Promise<OfficeCliProvisionState | null>`
  - `export async function writeOfficeCliProvisionState(config: ServerConfig, workspaceId: string, state: OfficeCliProvisionState): Promise<void>`

- [ ] **Step 1: Write failing tests** (append to `officecli-mcp.test.ts`)

```typescript
import type { ServerConfig } from "./types.js";
import {
  readOfficeCliProvisionState,
  writeOfficeCliProvisionState,
} from "./officecli-mcp.js";

function testServerConfig(workspaceRoot: string, workspaceId: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(workspaceRoot, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: workspaceId, name: "Test", path: workspaceRoot, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  } satisfies ServerConfig;
}

describe("officecli provision state", () => {
  test("reads and writes managed state in openwork workspace config", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "officecli-provision-"));
    const workspaceId = "ws_officecli";
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    const config = testServerConfig(workspaceRoot, workspaceId);
    try {
      expect(await readOfficeCliProvisionState(config, workspaceId)).toBeNull();
      await writeOfficeCliProvisionState(config, workspaceId, "managed");
      expect(await readOfficeCliProvisionState(config, workspaceId)).toBe("managed");
      await writeOfficeCliProvisionState(config, workspaceId, "removed");
      expect(await readOfficeCliProvisionState(config, workspaceId)).toBe("removed");
    } finally {
      process.env.OPENWORK_RUNTIME_DB = previousDb;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run — verify RED**

```bash
pnpm --dir apps/server exec bun test src/officecli-mcp.test.ts
```

- [ ] **Step 3: Implement** (append to `officecli-mcp.ts`)

```typescript
import type { ServerConfig } from "./types.js";
import {
  readOpenworkWorkspaceConfig,
  writeOpenworkWorkspaceConfig,
} from "./openwork-workspace-config-store.js";

export type OfficeCliProvisionState = "managed" | "removed";

const PROVISION_KEY = "officecliProvision";

function parseProvisionState(value: unknown): OfficeCliProvisionState | null {
  return value === "managed" || value === "removed" ? value : null;
}

export async function readOfficeCliProvisionState(
  config: ServerConfig,
  workspaceId: string,
): Promise<OfficeCliProvisionState | null> {
  const workspaceConfig = await readOpenworkWorkspaceConfig(config, workspaceId);
  return parseProvisionState(workspaceConfig[PROVISION_KEY]);
}

export async function writeOfficeCliProvisionState(
  config: ServerConfig,
  workspaceId: string,
  state: OfficeCliProvisionState,
): Promise<void> {
  await writeOpenworkWorkspaceConfig(config, workspaceId, (current) => ({
    ...current,
    [PROVISION_KEY]: state,
  }));
}
```

- [ ] **Step 4: Run — verify GREEN**

```bash
pnpm --dir apps/server exec bun test src/officecli-mcp.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/officecli-mcp.ts apps/server/src/officecli-mcp.test.ts
git commit -m "feat(server): persist OfficeCLI provision state per workspace"
```

---

### Task 3: `reconcileOfficeCliMcp`

**Files:**
- Modify: `apps/server/src/officecli-mcp.ts`
- Modify: `apps/server/src/officecli-mcp.test.ts`

**Interfaces:**
- Consumes: `readRuntimeOpencodeConfig`, `writeRuntimeOpencodeConfig` from `./runtime-opencode-config-store.js`
- Produces:
  - `export async function reconcileOfficeCliMcp(config: ServerConfig, workspaceId: string, binaryPath: string): Promise<"added" | "updated" | "skipped">`
  - `export async function reconcileOfficeCliMcpForAllWorkspaces(config: ServerConfig): Promise<void>`

- [ ] **Step 1: Write failing tests**

```typescript
import { readRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import {
  OFFICECLI_MCP_NAME,
  reconcileOfficeCliMcp,
  reconcileOfficeCliMcpForAllWorkspaces,
  writeOfficeCliProvisionState,
} from "./officecli-mcp.js";

describe("reconcileOfficeCliMcp", () => {
  test("adds managed local MCP when absent", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "officecli-reconcile-add-"));
    const workspaceId = "ws_add";
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    const config = testServerConfig(workspaceRoot, workspaceId);
    const binary = join(workspaceRoot, "officecli.exe");
    await writeFile(binary, "");
    try {
      const result = await reconcileOfficeCliMcp(config, workspaceId, binary);
      expect(result).toBe("added");
      const runtime = await readRuntimeOpencodeConfig(config, workspaceId);
      expect(runtime.mcp?.[OFFICECLI_MCP_NAME]).toEqual({
        type: "local",
        enabled: true,
        command: [binary, "mcp"],
        openworkManaged: true,
      });
    } finally {
      process.env.OPENWORK_RUNTIME_DB = previousDb;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("skips when provision state is removed", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "officecli-reconcile-removed-"));
    const workspaceId = "ws_removed";
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    const config = testServerConfig(workspaceRoot, workspaceId);
    const binary = join(workspaceRoot, "officecli.exe");
    await writeFile(binary, "");
    try {
      await writeOfficeCliProvisionState(config, workspaceId, "removed");
      const result = await reconcileOfficeCliMcp(config, workspaceId, binary);
      expect(result).toBe("skipped");
      expect(await readRuntimeOpencodeConfig(config, workspaceId)).toEqual({});
    } finally {
      process.env.OPENWORK_RUNTIME_DB = previousDb;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("does not modify user-owned MCP entry", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "officecli-reconcile-user-"));
    const workspaceId = "ws_user";
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    const config = testServerConfig(workspaceRoot, workspaceId);
    const binary = join(workspaceRoot, "officecli.exe");
    const userBinary = join(workspaceRoot, "custom-officecli.exe");
    await writeFile(binary, "");
    await writeFile(userBinary, "");
    const { writeRuntimeOpencodeConfig } = await import("./runtime-opencode-config-store.js");
    try {
      await writeRuntimeOpencodeConfig(config, workspaceId, (current) => ({
        ...current,
        mcp: {
          [OFFICECLI_MCP_NAME]: {
            type: "local",
            enabled: true,
            command: [userBinary, "mcp"],
          },
        },
      }));
      const result = await reconcileOfficeCliMcp(config, workspaceId, binary);
      expect(result).toBe("skipped");
      const runtime = await readRuntimeOpencodeConfig(config, workspaceId);
      expect(runtime.mcp?.[OFFICECLI_MCP_NAME]?.command).toEqual([userBinary, "mcp"]);
    } finally {
      process.env.OPENWORK_RUNTIME_DB = previousDb;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run — verify RED**

```bash
pnpm --dir apps/server exec bun test src/officecli-mcp.test.ts
```

- [ ] **Step 3: Implement reconcile functions**

```typescript
import {
  readRuntimeOpencodeConfig,
  runtimeMcpMap,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function managedOfficeCliEntry(binaryPath: string, enabled: boolean): Record<string, unknown> {
  return {
    type: "local",
    enabled,
    command: [binaryPath, "mcp"],
    openworkManaged: true,
  };
}

export async function reconcileOfficeCliMcp(
  config: ServerConfig,
  workspaceId: string,
  binaryPath: string,
): Promise<"added" | "updated" | "skipped"> {
  if (await readOfficeCliProvisionState(config, workspaceId) === "removed") {
    return "skipped";
  }

  const runtimeConfig = await readRuntimeOpencodeConfig(config, workspaceId);
  const mcpMap = runtimeMcpMap(runtimeConfig);
  const current = mcpMap[OFFICECLI_MCP_NAME];

  if (current && current.openworkManaged !== true) {
    return "skipped";
  }

  const enabled = current?.enabled !== false;
  const nextEntry = managedOfficeCliEntry(binaryPath, enabled);
  const currentCommand = Array.isArray(current?.command) ? current.command : [];
  const action = current ? "updated" : "added";

  if (
    current
    && currentCommand[0] === binaryPath
    && current.enabled === enabled
    && current.openworkManaged === true
  ) {
    return "skipped";
  }

  await writeRuntimeOpencodeConfig(config, workspaceId, (value) => ({
    ...value,
    mcp: { ...runtimeMcpMap(value), [OFFICECLI_MCP_NAME]: nextEntry },
  }));
  await writeOfficeCliProvisionState(config, workspaceId, "managed");
  return action;
}

export async function reconcileOfficeCliMcpForAllWorkspaces(config: ServerConfig): Promise<void> {
  const binaryPath = resolveOfficeCliBinary();
  if (!binaryPath) return;
  for (const workspace of config.workspaces) {
    await reconcileOfficeCliMcp(config, workspace.id, binaryPath);
  }
}
```

- [ ] **Step 4: Run — verify GREEN**

```bash
pnpm --dir apps/server exec bun test src/officecli-mcp.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/officecli-mcp.ts apps/server/src/officecli-mcp.test.ts
git commit -m "feat(server): reconcile managed OfficeCLI MCP per workspace"
```

---

### Task 4: Wire startup + workspace-create hooks

**Files:**
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/routes/workspaces.ts`

**Interfaces:**
- Consumes: `reconcileOfficeCliMcp`, `reconcileOfficeCliMcpForAllWorkspaces`, `resolveOfficeCliBinary` from `./officecli-mcp.js`

- [ ] **Step 1: Write failing integration test**

Append to `officecli-mcp.test.ts`:

```typescript
import { startServer } from "./server.js";

describe("officecli startup reconcile", () => {
  test("startServer provisions officecli MCP when binary exists on win32", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "officecli-startup-"));
    const workspaceId = "ws_startup";
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    const binary = join(workspaceRoot, "officecli.exe");
    await writeFile(binary, "");
    const config = testServerConfig(workspaceRoot, workspaceId);
    config.port = 0;
    process.env.OPENWORK_OFFICECLI_PATH = binary;
    let served: { stop: () => void } | null = null;
    try {
      const result = await startServer(config);
      served = result;
      const runtime = await readRuntimeOpencodeConfig(config, workspaceId);
      expect(runtime.mcp?.[OFFICECLI_MCP_NAME]?.command).toEqual([binary, "mcp"]);
    } finally {
      served?.stop();
      delete process.env.OPENWORK_OFFICECLI_PATH;
      process.env.OPENWORK_RUNTIME_DB = previousDb;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run — verify RED**

```bash
pnpm --dir apps/server exec bun test src/officecli-mcp.test.ts --test-name-pattern "startServer provisions"
```

- [ ] **Step 3: Hook `startServer` in `apps/server/src/server.ts`**

Add import:

```typescript
import { reconcileOfficeCliMcpForAllWorkspaces } from "./officecli-mcp.js";
```

After `reconcileLocalManagedMcpRuntimeEntries` block (~line 970):

```typescript
  try {
    await reconcileOfficeCliMcpForAllWorkspaces(config);
  } catch (error) {
    logger.log("warn", "Failed to reconcile OfficeCLI MCP during startup.", {
      error: error instanceof Error ? error.message : "unknown",
    });
  }
```

- [ ] **Step 4: Hook workspace create in `apps/server/src/routes/workspaces.ts`**

Add imports:

```typescript
import { reconcileOfficeCliMcp, resolveOfficeCliBinary } from "../officecli-mcp.js";
```

After `persistServerWorkspaceState(config)` in `POST /workspaces/local` (~line 308):

```typescript
    const officeCliBinary = resolveOfficeCliBinary();
    if (officeCliBinary) {
      await reconcileOfficeCliMcp(config, workspace.id, officeCliBinary);
    }
```

- [ ] **Step 5: Run — verify GREEN**

```bash
pnpm --dir apps/server exec bun test src/officecli-mcp.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/server.ts apps/server/src/routes/workspaces.ts apps/server/src/officecli-mcp.test.ts
git commit -m "feat(server): reconcile OfficeCLI MCP at startup and workspace create"
```

---

### Task 5: Desktop PATH enrichment (parallel with Tasks 1–4)

**Files:**
- Modify: `apps/desktop/electron/runtime.mjs`
- Modify: `apps/desktop/electron/runtime.test.mjs`

**Interfaces:**
- Produces:
  - `export function windowsOfficeCliPathCandidates(env = process.env)`

- [ ] **Step 1: Write failing test** (append to `runtime.test.mjs`)

```javascript
import { windowsOfficeCliPathCandidates } from "./runtime.mjs";

describe("windowsOfficeCliPathCandidates", () => {
  it("includes LOCALAPPDATA OfficeCLI on win32", () => {
    const candidates = windowsOfficeCliPathCandidates({
      LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local",
    });
    assert.ok(
      candidates.includes("C:\\Users\\Example\\AppData\\Local\\OfficeCLI"),
    );
  });

  it("returns empty list when LOCALAPPDATA is missing", () => {
    assert.deepEqual(windowsOfficeCliPathCandidates({}), []);
  });
});
```

- [ ] **Step 2: Run — verify RED**

```bash
pnpm --filter @openwork/desktop test electron/runtime.test.mjs --test-name-pattern "windowsOfficeCliPathCandidates"
```

- [ ] **Step 3: Implement in `runtime.mjs`**

Add exported helper before `extraPathEntries`:

```javascript
export function windowsOfficeCliPathCandidates(env = process.env) {
  if (process.platform !== "win32") return [];
  const localAppData = String(env.LOCALAPPDATA ?? "").trim();
  if (!localAppData) return [];
  return [path.join(localAppData, "OfficeCLI")];
}
```

Inside `extraPathEntries`, in the `win32` block, spread the helper:

```javascript
  if (process.platform === "win32") {
    candidates.push(
      ...windowsOfficeCliPathCandidates(process.env),
      path.join(home, ".volta", "bin"),
      // ...existing entries...
    );
  }
```

- [ ] **Step 4: Run — verify GREEN**

```bash
pnpm --filter @openwork/desktop test electron/runtime.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/runtime.mjs apps/desktop/electron/runtime.test.mjs
git commit -m "feat(desktop): add OfficeCLI to Windows PATH candidates"
```

---

### Task 6: Opt-out on managed MCP delete

**Files:**
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/officecli-mcp.test.ts`

**Interfaces:**
- Consumes: `readRuntimeOpencodeConfig`, `OFFICECLI_MCP_NAME`, `writeOfficeCliProvisionState`

- [ ] **Step 1: Write failing test**

```typescript
import { removeMcp } from "./mcp.js";

describe("officecli managed delete opt-out", () => {
  test("marks provision removed when managed officecli MCP is deleted", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "officecli-delete-"));
    const workspaceId = "ws_delete";
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    const config = testServerConfig(workspaceRoot, workspaceId);
    const binary = join(workspaceRoot, "officecli.exe");
    await writeFile(binary, "");
    try {
      await reconcileOfficeCliMcp(config, workspaceId, binary);
      await markOfficeCliManagedMcpRemoved(config, workspaceId);
      expect(await readOfficeCliProvisionState(config, workspaceId)).toBe("removed");
      expect(await removeMcp(config, workspaceId, OFFICECLI_MCP_NAME)).toBe(true);
      const retry = await reconcileOfficeCliMcp(config, workspaceId, binary);
      expect(retry).toBe("skipped");
    } finally {
      process.env.OPENWORK_RUNTIME_DB = previousDb;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
```

Export `markOfficeCliManagedMcpRemoved` from `officecli-mcp.ts` (implement before test passes).

- [ ] **Step 2: Implement `markOfficeCliManagedMcpRemoved`**

```typescript
export async function markOfficeCliManagedMcpRemoved(
  config: ServerConfig,
  workspaceId: string,
): Promise<void> {
  const runtimeConfig = await readRuntimeOpencodeConfig(config, workspaceId);
  const current = runtimeMcpMap(runtimeConfig)[OFFICECLI_MCP_NAME];
  if (current?.openworkManaged === true) {
    await writeOfficeCliProvisionState(config, workspaceId, "removed");
  }
}
```

- [ ] **Step 3: Call from DELETE route in `server.ts`**

Before `removeMcp` in `DELETE /workspace/:id/mcp/:name`:

```typescript
    if (name === OFFICECLI_MCP_NAME) {
      await markOfficeCliManagedMcpRemoved(config, workspace.id);
    }
```

Add imports for `OFFICECLI_MCP_NAME`, `markOfficeCliManagedMcpRemoved`.

- [ ] **Step 4: Run — verify GREEN**

```bash
pnpm --dir apps/server exec bun test src/officecli-mcp.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/officecli-mcp.ts apps/server/src/server.ts apps/server/src/officecli-mcp.test.ts
git commit -m "feat(server): opt out of OfficeCLI auto-provision after managed delete"
```

---

### Task 7: Verification + package Windows EXE

**Files:** None (commands only)

- [ ] **Step 1: Run full server + desktop unit tests**

```bash
pnpm --dir apps/server exec bun test src/officecli-mcp.test.ts
pnpm --filter @openwork/desktop test electron/runtime.test.mjs
```

Expected: all pass, exit code 0.

- [ ] **Step 2: Typecheck server**

```bash
pnpm --dir apps/server exec tsc -p tsconfig.json --noEmit
```

Expected: exit 0.

- [ ] **Step 3: Build and package Windows installer**

Prerequisites: Node 24, pnpm 11.4.0, Bun >= 1.3.10, VS Build Tools (for `better-sqlite3`).

```bash
pnpm install --frozen-lockfile
pnpm --filter @openwork/desktop build:electron
pnpm --dir apps/desktop exec electron-builder --config electron-builder.yml --win --publish never
```

Expected artifact:

```text
apps/desktop/dist-electron/openwork-win-x64-0.0.0-dev.exe
```

- [ ] **Step 4: Manual smoke on packaged app**

1. Install `openwork-win-x64-*.exe` (or run from `dist-electron/win-unpacked/OpenWork.exe`).
2. Confirm OfficeCLI still at `%LOCALAPPDATA%\OfficeCLI\officecli.exe`.
3. Create/open a workspace.
4. Settings → MCP: verify `officecli` entry exists with full path + enabled.
5. Attach a `.docx` in chat; ask agent to read first paragraph via OfficeCLI MCP.
6. Download result; confirm file changed.

Record pass/fail in PR notes or commit message body.

- [ ] **Step 5: Push feature branch**

```bash
git push -u origin feat/officecli-windows-auto-mcp
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Auto-detect `%LOCALAPPDATA%\OfficeCLI\officecli.exe` | Task 1 |
| `OPENWORK_OFFICECLI_PATH` override | Task 1 |
| PATH fallback scan | Task 1 |
| Managed MCP with full path + `openworkManaged` | Task 3 |
| Startup reconcile | Task 4 |
| Workspace create reconcile | Task 4 |
| User opt-out on delete | Task 6 |
| Preserve `enabled: false` | Task 3 |
| Don't modify user-owned entry | Task 3 |
| Windows PATH enrichment | Task 5 |
| Non-Windows no-op | Tasks 1, 5 |
| Reconcile must not block startup | Task 4 (try/catch) |
| Packaged exe smoke | Task 7 |

## Verification-before-completion gate

Do not claim the feature is done until all of the following have **fresh** command output in the PR or session:

1. `pnpm --dir apps/server exec bun test src/officecli-mcp.test.ts` → 0 failures
2. `pnpm --filter @openwork/desktop test electron/runtime.test.mjs` → 0 failures
3. `electron-builder --win --publish never` → installer exists under `apps/desktop/dist-electron/`
4. Manual smoke steps in Task 7 Step 4 completed
