import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { discoverWorlds, displayWorldPath, loadWorldSource } from "./loader.ts";
import { assertWorldName, WorldStateStore } from "./store.ts";
import {
  downScriptWorld,
  isProcessAlive,
  launchScriptWorld,
  readScriptWorldSnapshot,
  scriptWorldSnapshotDirectory,
  scriptWorldSnapshotPath,
} from "./script-world.ts";
import type { LaunchableWorldDefinition } from "./definition.ts";

export type WorldCommand =
  | {
      kind: "up";
      source: string;
      name?: string;
      keep?: boolean;
      detach?: boolean;
      allowSharedState?: boolean;
      replace?: boolean;
      keepTokens?: boolean;
      rotateTokens?: boolean;
      silent?: boolean;
      timeoutMs?: number;
    }
  | { kind: "rebuild"; snapshotPath: string; allowSharedState?: boolean; replace?: boolean }
  | { kind: "resume"; nameOrSnapshotPath: string; teardown?: boolean }
  | { kind: "down"; name: string }
  | { kind: "list" }
  | { kind: "forget"; name: string }
  | { kind: "help"; error?: string };

export interface WorldStartRequest {
  definition: LaunchableWorldDefinition;
  name: string;
  allowSharedState: boolean;
  replace: boolean;
  keepTokens: boolean;
  rotateTokens: boolean;
  silent: boolean;
}

export interface StartedWorldRuntime {
  name: string;
  lines: string[];
  detachedDefault?: boolean;
  sharedState?: boolean;
  snapshotPath?: string;
  snapshotText?: string;
  waitForExit?(): Promise<string>;
  detach(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ResumedWorldRuntime {
  name: string;
  lines: string[];
  sharedState?: boolean;
  detach(): Promise<void>;
  teardown(): Promise<string[]>;
}

export interface WorldSnapshotSummary {
  name: string;
  createdAt: string;
  line: string;
  sharedState?: boolean;
}

export interface WorldRuntimeAdapter {
  id: string;
  snapshotDirectory: string;
  start(request: WorldStartRequest): Promise<StartedWorldRuntime>;
  rebuild(snapshotText: string, request: Omit<WorldStartRequest, "definition" | "name">): Promise<StartedWorldRuntime>;
  resume(snapshotText: string, options: { teardown: boolean }): Promise<ResumedWorldRuntime>;
  summarize(snapshotText: string): WorldSnapshotSummary;
}

export interface WorldCliOptions {
  cwd: string;
  worldsDirectory: string;
  presets?: Readonly<Record<string, LaunchableWorldDefinition>>;
  adapters: readonly WorldRuntimeAdapter[];
  print?: (line: string) => void;
  onExit?: () => Promise<void>;
  loadFile?: (path: string) => Promise<string>;
}

function helpError(message: string): WorldCommand {
  return { kind: "help", error: message };
}

function flagError(): WorldCommand {
  return helpError("Use --name <name>, --detach, --timeout <ms>, --keep, --allow-shared-state, and supported compatibility flags after the world source.");
}

export function parseWorldArgs(argv: string[]): WorldCommand {
  const [command, ...args] = argv;
  if (!command || command === "help") {
    return args.length === 0 ? { kind: "help" } : helpError("The help command does not take arguments.");
  }
  if (command === "up") {
    const [source, ...options] = args;
    if (!source) return helpError("The up command needs a preset name or world file path.");
    let name: string | undefined;
    let keep = false;
    let detach = false;
    let allowSharedState = false;
    let replace = false;
    let keepTokens = false;
    let rotateTokens = false;
    let silent = false;
    let timeoutMs: number | undefined;
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index];
      if (option === "--name" && name === undefined) {
        const value = options[index + 1];
        if (!value || value.startsWith("--")) return helpError("Use --name followed by one world name.");
        name = value;
        index += 1;
        continue;
      }
      if (option === "--keep" && !keep) { keep = true; continue; }
      if (option === "--detach" && !detach) { detach = true; continue; }
      if (option === "--allow-shared-state" && !allowSharedState) { allowSharedState = true; continue; }
      if (option === "--replace" && !replace) { replace = true; continue; }
      if (option === "--keep-tokens" && !keepTokens) { keepTokens = true; continue; }
      if (option === "--rotate-tokens" && !rotateTokens) { rotateTokens = true; continue; }
      if (option === "--silent" && !silent) { silent = true; continue; }
      if (option === "--timeout" && timeoutMs === undefined) {
        const value = options[index + 1];
        const parsed = value === undefined ? Number.NaN : Number(value);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) return helpError("Use --timeout followed by a positive number of milliseconds.");
        timeoutMs = parsed;
        index += 1;
        continue;
      }
      return flagError();
    }
    if (keep && detach) return helpError("Use either --keep or --detach, not both.");
    if (timeoutMs !== undefined && !detach) return helpError("Use --timeout only with --detach.");
    return {
      kind: "up",
      source,
      ...(name === undefined ? {} : { name }),
      ...(keep ? { keep: true } : {}),
      ...(detach ? { detach: true } : {}),
      ...(allowSharedState ? { allowSharedState: true } : {}),
      ...(replace ? { replace: true } : {}),
      ...(keepTokens ? { keepTokens: true } : {}),
      ...(rotateTokens ? { rotateTokens: true } : {}),
      ...(silent ? { silent: true } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }
  if (command === "rebuild") {
    const [snapshotPath, ...options] = args;
    if (!snapshotPath) return helpError("The rebuild command needs one snapshot path.");
    const allowSharedState = options.includes("--allow-shared-state");
    const replace = options.includes("--replace");
    const expected = Number(allowSharedState) + Number(replace);
    if (options.length !== expected) return helpError("Use only --allow-shared-state and/or --replace after the rebuild snapshot path.");
    return {
      kind: "rebuild",
      snapshotPath,
      ...(allowSharedState ? { allowSharedState: true } : {}),
      ...(replace ? { replace: true } : {}),
    };
  }
  if (command === "resume") {
    const [nameOrSnapshotPath, ...options] = args;
    if (!nameOrSnapshotPath) return helpError("The resume command needs a world name or snapshot path.");
    if (options.length === 0) return { kind: "resume", nameOrSnapshotPath };
    if (options.length === 1 && options[0] === "--teardown") {
      return { kind: "resume", nameOrSnapshotPath, teardown: true };
    }
    return helpError("Use only --teardown after the world name or snapshot path.");
  }
  if (command === "list") return args.length === 0 ? { kind: "list" } : helpError("The list command does not take arguments.");
  if (command === "down") {
    return args.length === 1 && args[0]
      ? { kind: "down", name: args[0] }
      : helpError("The down command needs exactly one world name.");
  }
  if (command === "forget") {
    return args.length === 1 && args[0]
      ? { kind: "forget", name: args[0] }
      : helpError("The forget command needs exactly one world name.");
  }
  return helpError(`Unknown command ${JSON.stringify(command)}.`);
}

function defaultOnExit(): Promise<void> {
  return new Promise((done) => {
    const exit = (): void => {
      process.off("SIGINT", exit);
      process.off("SIGTERM", exit);
      done();
    };
    process.once("SIGINT", exit);
    process.once("SIGTERM", exit);
  });
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function adapterById(adapters: readonly WorldRuntimeAdapter[], id: string): WorldRuntimeAdapter {
  const adapter = adapters.find((candidate) => candidate.id === id);
  if (!adapter) throw new Error(`No runtime adapter is registered for world adapter ${JSON.stringify(id)}.`);
  return adapter;
}

function adapterForSnapshot(
  adapters: readonly WorldRuntimeAdapter[],
  snapshotText: string,
): { adapter: WorldRuntimeAdapter; summary: WorldSnapshotSummary } {
  for (const adapter of adapters) {
    try {
      return { adapter, summary: adapter.summarize(snapshotText) };
    } catch {
      // Try the next registered snapshot format.
    }
  }
  throw new Error("The snapshot is not recognized by any registered world runtime adapter.");
}

function printStarted(
  runtime: StartedWorldRuntime | ResumedWorldRuntime,
  description: string,
  snapshotPath: string | undefined,
  lifecycle: string,
  print: (line: string) => void,
): void {
  if (runtime.sharedState) {
    print("LIVE SHARED PRODUCTION STATE — concurrent writes by production and dev are unsupported and may corrupt state.");
  }
  print(`World ${JSON.stringify(runtime.name)} is up (${description}${runtime.sharedState ? ", LIVE SHARED PRODUCTION STATE" : ""}).`);
  for (const line of runtime.lines) print(line);
  if (snapshotPath) print(`snapshot  ${snapshotPath}`);
  print(lifecycle);
}

async function persistRuntimeSnapshot(
  adapter: WorldRuntimeAdapter,
  runtime: StartedWorldRuntime,
): Promise<string | undefined> {
  if (runtime.snapshotPath) return runtime.snapshotPath;
  if (!runtime.snapshotText) return undefined;
  return new WorldStateStore(adapter.snapshotDirectory).save(runtime.name, runtime.snapshotText);
}

async function runStarted(
  adapter: WorldRuntimeAdapter,
  runtime: StartedWorldRuntime,
  options: { description: string; immediateDetach: boolean; keepAfterSignal: boolean },
  io: { print: (line: string) => void; onExit: () => Promise<void>; cwd: string },
): Promise<number> {
  type RuntimeExit = { kind: "signal" } | { kind: "runtime"; reason: string };
  let released = false;
  try {
    const snapshotPath = await persistRuntimeSnapshot(adapter, runtime);
    const displayedSnapshot = snapshotPath ? displayWorldPath(snapshotPath, io.cwd) : undefined;
    if (options.immediateDetach) {
      printStarted(runtime, options.description, displayedSnapshot, `Detached; tear down with: pnpm world resume ${runtime.name} --teardown`, io.print);
      await runtime.detach();
      released = true;
      return 0;
    }
    const lifecycle = options.keepAfterSignal
      ? `Ctrl-C detaches; tear down later with: pnpm world resume ${runtime.name} --teardown`
      : "Stays up until Ctrl-C; Ctrl-C tears everything down.";
    printStarted(runtime, options.description, displayedSnapshot, lifecycle, io.print);
    const signalExit: Promise<RuntimeExit> = io.onExit().then(() => ({ kind: "signal" }));
    const exit = runtime.waitForExit
      ? await Promise.race([
          signalExit,
          runtime.waitForExit().then((reason): RuntimeExit => ({ kind: "runtime", reason })),
        ])
      : await signalExit;
    if (exit.kind === "runtime") {
      await runtime.dispose();
      released = true;
      io.print(`World ${JSON.stringify(runtime.name)} stopped unexpectedly: ${exit.reason}`);
      return 1;
    }
    if (options.keepAfterSignal) {
      await runtime.detach();
      io.print(`Detached from world ${JSON.stringify(runtime.name)}; it is still running.`);
    } else {
      await runtime.dispose();
      io.print(`World ${JSON.stringify(runtime.name)} torn down.`);
    }
    released = true;
    return 0;
  } finally {
    if (!released) {
      await runtime.dispose().catch((error: unknown) => {
        io.print(`World ${JSON.stringify(runtime.name)} cleanup failed: ${messageText(error)}`);
      });
    }
  }
}

async function helpText(options: WorldCliOptions): Promise<string> {
  const discovered = await discoverWorlds(options.worldsDirectory);
  const sources = [
    ...Object.keys(options.presets ?? {}),
    ...discovered.map((world) => displayWorldPath(world.path, options.cwd)),
  ];
  return `Usage:
  pnpm world up <preset-or-world-path> [--name <name>] [--detach] [--timeout <ms>] [--allow-shared-state]
  pnpm world down <name>
  pnpm world rebuild <snapshot-path> [--allow-shared-state]
  pnpm world resume <name-or-snapshot-path> [--teardown]
  pnpm world list
  pnpm world forget <name>
  pnpm world help

Script world files run in the foreground by default; use --detach to launch them in the background.
Definition world files default their name from the filename and may default to detached mode.
Available worlds: ${sources.join(", ") || "(none)"}`;
}

async function loadNamedSnapshot(
  adapters: readonly WorldRuntimeAdapter[],
  nameOrPath: string,
  load: (path: string) => Promise<string>,
): Promise<{ path: string; text: string; adapter: WorldRuntimeAdapter; summary: WorldSnapshotSummary }> {
  if (nameOrPath.endsWith(".json") || nameOrPath.includes("/") || nameOrPath.includes("\\")) {
    const text = await load(nameOrPath);
    const parsed = adapterForSnapshot(adapters, text);
    return { path: nameOrPath, text, ...parsed };
  }
  const matches: { path: string; text: string; adapter: WorldRuntimeAdapter; summary: WorldSnapshotSummary }[] = [];
  for (const adapter of adapters) {
    const path = new WorldStateStore(adapter.snapshotDirectory).path(nameOrPath);
    try {
      const text = await load(path);
      const summary = adapter.summarize(text);
      matches.push({ path, text, adapter, summary });
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  if (matches.length > 1) {
    throw new Error(
      `World name ${JSON.stringify(nameOrPath)} is ambiguous across adapters: ${matches.map((match) => match.adapter.id).join(", ")}. Use an explicit snapshot path.`,
    );
  }
  if (matches[0]) return matches[0];
  throw new Error(`World snapshot ${JSON.stringify(nameOrPath)} does not exist.`);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

async function runResume(
  nameOrSnapshotPath: string,
  teardown: boolean,
  options: WorldCliOptions,
  io: { print: (line: string) => void; onExit: () => Promise<void>; load: (path: string) => Promise<string> },
): Promise<number> {
  const saved = await loadNamedSnapshot(options.adapters, nameOrSnapshotPath, io.load);
  const runtime = await saved.adapter.resume(saved.text, { teardown });
  printStarted(
    runtime,
    "resumed from snapshot",
    displayWorldPath(saved.path, options.cwd),
    teardown ? "Teardown requested; stopping resolved services." : "Attached mode: Ctrl-C detaches; the world keeps running.",
    io.print,
  );
  if (teardown) {
    for (const line of await runtime.teardown()) io.print(line);
    return 0;
  }
  await io.onExit();
  await runtime.detach();
  io.print(`Detached from world ${JSON.stringify(runtime.name)}; it is still running.`);
  return 0;
}

export async function main(argv: string[], options: WorldCliOptions): Promise<number> {
  const print = options.print ?? console.log;
  const onExit = options.onExit ?? defaultOnExit;
  const load = options.loadFile ?? ((path: string) => readFile(path, "utf8"));
  const command = parseWorldArgs(argv);
  if (command.kind === "help") {
    if (command.error) print(command.error);
    print(await helpText(options));
    return command.error ? 1 : 0;
  }
  if (command.kind === "up") {
    try {
      const loaded = await loadWorldSource(command.source, {
        cwd: options.cwd,
        worldsDirectory: options.worldsDirectory,
        presets: options.presets ?? {},
      });
      if (loaded.kind === "script") {
        if (
          command.name !== undefined
          || command.keep === true
          || command.allowSharedState === true
          || command.replace === true
          || command.keepTokens === true
          || command.rotateTokens === true
          || command.silent === true
        ) {
          throw new Error("Script worlds support only --detach and --timeout.");
        }
        return await launchScriptWorld({
          path: loaded.path,
          name: loaded.name,
          snapshotDirectory: scriptWorldSnapshotDirectory(options.cwd),
          detach: command.detach === true,
          ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
          print,
        });
      }
      if (command.timeoutMs !== undefined) throw new Error("--timeout is supported only for detached script worlds.");
      if (loaded.definition.requiresSharedState && command.allowSharedState !== true) {
        throw new Error("Refusing LIVE SHARED PRODUCTION STATE launch without explicit --allow-shared-state opt-in.");
      }
      const name = command.name
        ?? loaded.defaultName
        ?? `world-${Date.now().toString(36)}-${process.pid.toString(36)}`;
      assertWorldName(name);
      const adapter = adapterById(options.adapters, loaded.definition.adapter);
      const runtime = await adapter.start({
        definition: loaded.definition,
        name,
        allowSharedState: command.allowSharedState === true,
        replace: command.replace === true,
        keepTokens: command.keepTokens === true,
        rotateTokens: command.rotateTokens === true,
        silent: command.silent === true,
      });
      return await runStarted(adapter, runtime, {
        description: loaded.description,
        immediateDetach: loaded.definition.detached || command.detach === true,
        keepAfterSignal: command.keep === true,
      }, { print, onExit, cwd: options.cwd });
    } catch (error) {
      print(messageText(error));
      return 1;
    }
  }
  if (command.kind === "rebuild") {
    try {
      const text = await load(command.snapshotPath);
      const { adapter } = adapterForSnapshot(options.adapters, text);
      const runtime = await adapter.rebuild(text, {
        allowSharedState: command.allowSharedState === true,
        replace: command.replace === true,
        keepTokens: false,
        rotateTokens: false,
        silent: false,
      });
      return await runStarted(adapter, runtime, {
        description: "rebuilt from snapshot",
        immediateDetach: runtime.detachedDefault === true,
        keepAfterSignal: false,
      }, { print, onExit, cwd: options.cwd });
    } catch (error) {
      print(messageText(error));
      return 1;
    }
  }
  if (command.kind === "resume") {
    try {
      return await runResume(command.nameOrSnapshotPath, command.teardown === true, options, { print, onExit, load });
    } catch (error) {
      print(messageText(error));
      return 1;
    }
  }
  if (command.kind === "down") {
    try {
      const scriptPath = scriptWorldSnapshotPath(scriptWorldSnapshotDirectory(options.cwd), command.name);
      const result = await downScriptWorld(scriptPath);
      if (!result.found) return await runResume(command.name, true, options, { print, onExit, load });
      if (result.forced) {
        print(`World ${JSON.stringify(command.name)} teardown was forced (pid ${result.pid}).`);
      } else {
        print(`World ${JSON.stringify(command.name)} torn down.`);
      }
      return 0;
    } catch (error) {
      print(messageText(error));
      return 1;
    }
  }
  if (command.kind === "list") {
    const discovered = await discoverWorlds(options.worldsDirectory);
    print(`World files: ${discovered.map((world) => `${world.name} (${displayWorldPath(world.path, options.cwd)}, unclassified)`).join(", ") || "(none)"}`);
    let count = 0;
    for (const adapter of options.adapters) {
      for (const path of await new WorldStateStore(adapter.snapshotDirectory).list()) {
        try {
          const summary = adapter.summarize(await load(path));
          print(summary.line);
          count += 1;
        } catch (error) {
          print(`Warning: skipped ${displayWorldPath(path, options.cwd)}: ${messageText(error)}`);
        }
      }
    }
    const scriptsDirectory = scriptWorldSnapshotDirectory(options.cwd);
    for (const path of await new WorldStateStore(scriptsDirectory).list()) {
      try {
        const snapshot = await readScriptWorldSnapshot(path);
        if (!snapshot) continue;
        print(`${snapshot.name}  ${snapshot.createdAt}  script  ${isProcessAlive(snapshot.pid) ? "alive" : `dead(pid ${snapshot.pid})`}`);
        count += 1;
      } catch (error) {
        print(`Warning: skipped ${displayWorldPath(path, options.cwd)}: ${messageText(error)}`);
      }
    }
    if (count === 0) print("No world snapshots.");
    return 0;
  }
  const scriptStore = new WorldStateStore(scriptWorldSnapshotDirectory(options.cwd));
  const scriptSnapshotExists = await scriptStore.read(command.name).then(() => true, (error: unknown) => {
    if (isMissingFile(error)) return false;
    throw error;
  });
  const stores: { adapter: WorldRuntimeAdapter; store: WorldStateStore }[] = [];
  for (const adapter of options.adapters) {
    const store = new WorldStateStore(adapter.snapshotDirectory);
    try {
      await store.read(command.name);
      stores.push({ adapter, store });
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  if (stores.length === 0 && !scriptSnapshotExists) {
    print(`World snapshot ${JSON.stringify(command.name)} does not exist.`);
    return 1;
  }
  if (stores.length > 1) {
    print(`World name ${JSON.stringify(command.name)} is ambiguous across adapters: ${stores.map((entry) => entry.adapter.id).join(", ")}. Forget an explicit snapshot after resolving the collision.`);
    return 1;
  }
  const matchedStore = stores[0];
  if (matchedStore) await matchedStore.store.forget(command.name);
  if (scriptSnapshotExists) await scriptStore.forget(command.name);
  print(`Removed snapshot metadata for ${JSON.stringify(command.name)}. Detached services were not stopped.`);
  return 0;
}

export function defaultWorldCliPaths(repoRoot: string): { cwd: string; worldsDirectory: string } {
  const cwd = resolve(repoRoot);
  return { cwd, worldsDirectory: join(cwd, "worlds") };
}
