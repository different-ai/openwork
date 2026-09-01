import { access, rm } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { discoverWorlds, displayWorldPath, resolveWorldScript } from "./loader.ts";
import { receiptName, resolveStage, sanitizeStage } from "./stage.ts";
import { WorldStateStore } from "./store.ts";
import {
  computeRecipeHash,
  downScriptWorld,
  isProcessAlive,
  launchScriptWorld,
  readScriptWorldSnapshot,
  scriptWorldSnapshotDirectory,
  scriptWorldSnapshotPath,
} from "./script-world.ts";

export type WorldCommand =
  | {
      kind: "up";
      source: string;
      detach?: boolean;
      timeoutMs?: number;
      stage?: string;
      place?: "local" | "daytona";
      args: string[];
    }
  | { kind: "down"; name: string; stage?: string }
  | { kind: "plan"; source: string; stage?: string }
  | { kind: "list" }
  | { kind: "forget"; name: string }
  | { kind: "help"; error?: string };

export interface WorldCliOptions {
  cwd: string;
  worldsDirectory: string;
  print?: (line: string) => void;
}

function helpError(message: string): WorldCommand {
  return { kind: "help", error: message };
}

function parseStageOptions(options: string[]): { stage?: string; error?: string } {
  let stage: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--stage" && stage === undefined) {
      const value = options[index + 1];
      try {
        stage = sanitizeStage(value ?? "");
      } catch {
        return { error: "Use --stage followed by a non-empty stage value." };
      }
      index += 1;
      continue;
    }
    return { error: `Unknown world CLI option ${JSON.stringify(option)}.` };
  }
  return stage === undefined ? {} : { stage };
}

export function parseWorldArgs(argv: string[]): WorldCommand {
  const [command, ...args] = argv;
  if (!command || command === "help") {
    return args.length === 0 ? { kind: "help" } : helpError("The help command does not take arguments.");
  }
  if (command === "up") {
    const [source, ...rest] = args;
    if (!source || source === "--" || source.startsWith("--")) {
      return helpError("The up command needs a script path or world name.");
    }
    const separator = rest.indexOf("--");
    const options = separator === -1 ? rest : rest.slice(0, separator);
    const scriptArgs = separator === -1 ? [] : rest.slice(separator + 1);
    let detach = false;
    let timeoutMs: number | undefined;
    let stage: string | undefined;
    let place: "local" | "daytona" | undefined;
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index];
      if (option === "--detach" && !detach) {
        detach = true;
        continue;
      }
      if (option === "--timeout" && timeoutMs === undefined) {
        const value = options[index + 1];
        const parsed = value === undefined ? Number.NaN : Number(value);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          return helpError("Use --timeout followed by a positive number of milliseconds.");
        }
        timeoutMs = parsed;
        index += 1;
        continue;
      }
      if (option === "--stage" && stage === undefined) {
        const value = options[index + 1];
        try {
          stage = sanitizeStage(value ?? "");
        } catch {
          return helpError("Use --stage followed by a non-empty stage value.");
        }
        index += 1;
        continue;
      }
      if (option === "--place" && place === undefined) {
        const value = options[index + 1];
        if (value !== "local" && value !== "daytona") {
          return helpError("Use --place followed by local or daytona.");
        }
        place = value;
        index += 1;
        continue;
      }
      return helpError(`Unknown world CLI option ${JSON.stringify(option)}. Pass script arguments after --.`);
    }
    if (timeoutMs !== undefined && !detach) return helpError("Use --timeout only with --detach.");
    return {
      kind: "up",
      source,
      ...(detach ? { detach: true } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(stage === undefined ? {} : { stage }),
      ...(place === undefined ? {} : { place }),
      args: scriptArgs,
    };
  }
  if (command === "plan") {
    const [source, ...options] = args;
    if (!source || source === "--" || source.startsWith("--")) {
      return helpError("The plan command needs a script path or world name.");
    }
    const parsed = parseStageOptions(options);
    if (parsed.error) return helpError(parsed.error);
    return { kind: "plan", source, ...(parsed.stage === undefined ? {} : { stage: parsed.stage }) };
  }
  if (command === "list") {
    return args.length === 0 ? { kind: "list" } : helpError("The list command does not take arguments.");
  }
  if (command === "down") {
    const [name, ...options] = args;
    if (!name || name === "--" || name.startsWith("--")) {
      return helpError("The down command needs exactly one world name.");
    }
    const parsed = parseStageOptions(options);
    if (parsed.error) return helpError(parsed.error);
    return { kind: "down", name, ...(parsed.stage === undefined ? {} : { stage: parsed.stage }) };
  }
  if (command === "forget") {
    return args.length === 1 && args[0]
      ? { kind: "forget", name: args[0] }
      : helpError("The forget command needs exactly one world name.");
  }
  return helpError(`Unknown command ${JSON.stringify(command)}. Script worlds support up, plan, down, list, forget, and help.`);
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function helpText(options: WorldCliOptions): Promise<string> {
  const discovered = await discoverWorlds(options.worldsDirectory);
  const sources = discovered.map((world) => displayWorldPath(world.path, options.cwd));
  return `Usage:
  pnpm world up <script-path-or-name> [--detach] [--timeout <ms>] [--stage <value>] [--place <local|daytona>] [-- <script args...>]
  pnpm world plan <script-path-or-name> [--stage <value>]
  pnpm world down <name> [--stage <value>]
  pnpm world list
  pnpm world forget <name>
  pnpm world help

World scripts run in the foreground by default; use --detach for background lifecycle receipts.
Available world scripts: ${sources.join(", ") || "(none)"}`;
}

type ScriptReceiptState =
  | { kind: "create" }
  | { kind: "running" | "changed" | "orphaned"; snapshot: NonNullable<Awaited<ReturnType<typeof readScriptWorldSnapshot>>> };

async function classifyScriptReceipt(path: string, recipeHash: string): Promise<ScriptReceiptState> {
  const snapshot = await readScriptWorldSnapshot(path);
  if (!snapshot) return { kind: "create" };
  if (!isProcessAlive(snapshot.pid)) return { kind: "orphaned", snapshot };
  return snapshot.recipeHash === undefined || snapshot.recipeHash === recipeHash
    ? { kind: "running", snapshot }
    : { kind: "changed", snapshot };
}

function printOutputs(
  snapshot: NonNullable<Awaited<ReturnType<typeof readScriptWorldSnapshot>>>,
  print: (line: string) => void,
): void {
  for (const [key, value] of Object.entries(snapshot.outputs)) print(`${key}  ${value}`);
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

export async function main(argv: string[], options: WorldCliOptions): Promise<number> {
  const print = options.print ?? console.log;
  const command = parseWorldArgs(argv);
  if (command.kind === "help") {
    if (command.error) print(command.error);
    print(await helpText(options));
    return command.error ? 1 : 0;
  }
  if (command.kind === "up") {
    try {
      const script = await resolveWorldScript(command.source, options);
      const stage = resolveStage(process.env, command.stage);
      const recipeHash = await computeRecipeHash(script.path);
      const snapshotDirectory = scriptWorldSnapshotDirectory(options.cwd);
      const stagedName = receiptName(script.name, stage);
      const snapshotPath = scriptWorldSnapshotPath(snapshotDirectory, stagedName);
      const state = await classifyScriptReceipt(snapshotPath, recipeHash);
      if (state.kind === "running") {
        printOutputs(state.snapshot, print);
        print(`World ${JSON.stringify(stagedName)} is already running (pid ${state.snapshot.pid}); adopted.`);
        return 0;
      }
      if (state.kind === "changed") {
        print(`World ${JSON.stringify(stagedName)} is running but its recipe changed; run pnpm world down ${script.name}${stage ? ` --stage ${stage}` : ""} first.`);
        return 1;
      }
      if (state.kind === "orphaned") {
        await rm(snapshotPath, { force: true });
        print(`Removed stale world receipt ${JSON.stringify(stagedName)} (pid ${state.snapshot.pid}); recreating.`);
      }
      return await launchScriptWorld({
        path: script.path,
        name: script.name,
        args: command.args,
        snapshotDirectory,
        detach: command.detach === true,
        ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
        ...(stage === undefined ? {} : { stage }),
        recipeHash,
        ...(command.place === undefined ? {} : { place: command.place }),
        print,
      });
    } catch (error) {
      print(messageText(error));
      return 1;
    }
  }
  if (command.kind === "plan") {
    try {
      const script = await resolveWorldScript(command.source, options);
      const stage = resolveStage(process.env, command.stage);
      const recipeHash = await computeRecipeHash(script.path);
      const snapshotPath = scriptWorldSnapshotPath(
        scriptWorldSnapshotDirectory(options.cwd),
        receiptName(script.name, stage),
      );
      const state = await classifyScriptReceipt(snapshotPath, recipeHash);
      const labels = {
        create: "+ create",
        running: "• running (attachable)",
        changed: "~ stale (recipe changed)",
        orphaned: "- orphaned (stale receipt, will recreate)",
      };
      print(labels[state.kind]);
      print(`receipt  ${snapshotPath}`);
      if (state.kind !== "create") printOutputs(state.snapshot, print);
      return 0;
    } catch (error) {
      print(messageText(error));
      return 1;
    }
  }
  if (command.kind === "down") {
    try {
      const snapshotDirectory = scriptWorldSnapshotDirectory(options.cwd);
      let stagedName = receiptName(command.name, command.stage);
      let path = scriptWorldSnapshotPath(snapshotDirectory, stagedName);
      if (command.stage === undefined && !await pathExists(path)) {
        const prefix = `${command.name}--`;
        const candidates = (await new WorldStateStore(snapshotDirectory).list())
          .map((candidatePath) => basename(candidatePath, extname(candidatePath)))
          .filter((candidate) => candidate.startsWith(prefix));
        if (candidates.length > 1) {
          print(`Multiple staged world receipts match ${JSON.stringify(command.name)}:`);
          for (const candidate of candidates) print(`  ${candidate}`);
          return 1;
        }
        if (candidates[0]) {
          stagedName = candidates[0];
          path = scriptWorldSnapshotPath(snapshotDirectory, stagedName);
        }
      }
      const result = await downScriptWorld(path);
      if (!result.found) {
        print(`World receipt ${JSON.stringify(stagedName)} does not exist.`);
        return 1;
      }
      if (result.forced) {
        print(`World ${JSON.stringify(stagedName)} teardown was forced (pid ${result.pid}).`);
      } else {
        print(`World ${JSON.stringify(stagedName)} torn down.`);
      }
      return 0;
    } catch (error) {
      print(messageText(error));
      return 1;
    }
  }
  if (command.kind === "list") {
    const discovered = await discoverWorlds(options.worldsDirectory);
    print(`World scripts: ${discovered.map((world) => `${world.name} (${displayWorldPath(world.path, options.cwd)}, script)`).join(", ") || "(none)"}`);
    let count = 0;
    const receiptsDirectory = scriptWorldSnapshotDirectory(options.cwd);
    for (const path of await new WorldStateStore(receiptsDirectory).list()) {
      try {
        const receipt = await readScriptWorldSnapshot(path);
        if (!receipt) continue;
        print(`${receipt.name}  ${receipt.createdAt}  script  ${isProcessAlive(receipt.pid) ? "alive" : `dead(pid ${receipt.pid})`}`);
        count += 1;
      } catch (error) {
        print(`Warning: skipped ${displayWorldPath(path, options.cwd)}: ${messageText(error)}`);
      }
    }
    if (count === 0) print("No script world receipts.");
    return 0;
  }

  try {
    const store = new WorldStateStore(scriptWorldSnapshotDirectory(options.cwd));
    if (!await store.forget(command.name)) {
      print(`World receipt ${JSON.stringify(command.name)} does not exist.`);
      return 1;
    }
    print(`Removed receipt metadata for ${JSON.stringify(command.name)}. The script process was not stopped.`);
    return 0;
  } catch (error) {
    print(messageText(error));
    return 1;
  }
}

export function defaultWorldCliPaths(repoRoot: string): { cwd: string; worldsDirectory: string } {
  const cwd = resolve(repoRoot);
  return { cwd, worldsDirectory: join(cwd, "worlds") };
}
