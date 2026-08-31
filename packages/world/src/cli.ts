import { join, resolve } from "node:path";
import { discoverWorlds, displayWorldPath, resolveWorldScript } from "./loader.ts";
import { WorldStateStore } from "./store.ts";
import {
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
      args: string[];
    }
  | { kind: "down"; name: string }
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
      return helpError(`Unknown world CLI option ${JSON.stringify(option)}. Pass script arguments after --.`);
    }
    if (timeoutMs !== undefined && !detach) return helpError("Use --timeout only with --detach.");
    return {
      kind: "up",
      source,
      ...(detach ? { detach: true } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      args: scriptArgs,
    };
  }
  if (command === "list") {
    return args.length === 0 ? { kind: "list" } : helpError("The list command does not take arguments.");
  }
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
  return helpError(`Unknown command ${JSON.stringify(command)}. Script worlds support up, down, list, forget, and help.`);
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function helpText(options: WorldCliOptions): Promise<string> {
  const discovered = await discoverWorlds(options.worldsDirectory);
  const sources = discovered.map((world) => displayWorldPath(world.path, options.cwd));
  return `Usage:
  pnpm world up <script-path-or-name> [--detach] [--timeout <ms>] [-- <script args...>]
  pnpm world down <name>
  pnpm world list
  pnpm world forget <name>
  pnpm world help

World scripts run in the foreground by default; use --detach for background lifecycle receipts.
Available world scripts: ${sources.join(", ") || "(none)"}`;
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
      return await launchScriptWorld({
        path: script.path,
        name: script.name,
        args: command.args,
        snapshotDirectory: scriptWorldSnapshotDirectory(options.cwd),
        detach: command.detach === true,
        ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
        print,
      });
    } catch (error) {
      print(messageText(error));
      return 1;
    }
  }
  if (command.kind === "down") {
    try {
      const path = scriptWorldSnapshotPath(scriptWorldSnapshotDirectory(options.cwd), command.name);
      const result = await downScriptWorld(path);
      if (!result.found) {
        print(`World receipt ${JSON.stringify(command.name)} does not exist.`);
        return 1;
      }
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
