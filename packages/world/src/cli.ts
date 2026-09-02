import { access, readdir, rm } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { styleText } from "node:util";
import { eventsPath, readEvents, tailEvents, type WorldEvent } from "./events.ts";
import { ledgerPath, readLedger } from "./ledger.ts";
import { discoverWorlds, displayWorldPath, resolveWorldScript } from "./loader.ts";
import { formatOutputLines, MASK } from "./outputs.ts";
import { nodeCheck, runPreflight, type PreflightCheck } from "./preflight.ts";
import { builtinReapers, reapLedger, type ReapReport, type Reaper } from "./reaper.ts";
import { receiptName, resolveStage, sanitizeStage } from "./stage.ts";
import { WorldStateStore } from "./store.ts";
import {
  computeRecipeHash,
  downScriptWorld,
  isProcessAlive,
  launchScriptWorld,
  readScriptWorldSnapshot,
  readLastLogLines,
  scriptWorldLogPath,
  scriptWorldSnapshotDirectory,
  scriptWorldSnapshotPath,
} from "./script-world.ts";
import { createWorldView, detectViewMode, type ViewSink, type WorldView } from "./view.ts";

export type WorldCommand =
  | {
      kind: "up";
      source: string;
      detach?: boolean;
      timeoutMs?: number;
      stage?: string;
      place?: "local" | "daytona";
      plain?: true;
      args: string[];
    }
  | { kind: "attach"; name: string; stage?: string; plain?: true }
  | { kind: "down"; name: string; stage?: string; purge?: true }
  | { kind: "outputs"; name: string; stage?: string; reveal?: true; json?: true }
  | { kind: "plan"; source: string; stage?: string }
  | { kind: "list" }
  | { kind: "forget"; name: string }
  | { kind: "help"; error?: string };

export interface WorldCliOptions {
  cwd: string;
  worldsDirectory: string;
  print?: (line: string) => void;
  progress?: (line: string) => void;
  preflight?: PreflightCheck[];
  viewMode?: "tty" | "plain";
  reapers?: Record<string, Reaper>;
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
    let plain = false;
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
      if (option === "--plain" && !plain) {
        plain = true;
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
      ...(plain ? { plain: true } : {}),
      args: scriptArgs,
    };
  }
  if (command === "attach") {
    const [name, ...options] = args;
    if (!name || name === "--" || name.startsWith("--")) {
      return helpError("The attach command needs exactly one world name.");
    }
    let stage: string | undefined;
    let plain = false;
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index];
      if (option === "--stage" && stage === undefined) {
        try {
          stage = sanitizeStage(options[index + 1] ?? "");
        } catch {
          return helpError("Use --stage followed by a non-empty stage value.");
        }
        index += 1;
        continue;
      }
      if (option === "--plain" && !plain) {
        plain = true;
        continue;
      }
      return helpError(`Unknown world CLI option ${JSON.stringify(option)}.`);
    }
    return {
      kind: "attach",
      name,
      ...(stage === undefined ? {} : { stage }),
      ...(plain ? { plain: true } : {}),
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
  if (command === "outputs") {
    const [name, ...options] = args;
    if (!name || name === "--" || name.startsWith("--")) {
      return helpError("The outputs command needs exactly one world name.");
    }
    let stage: string | undefined;
    let reveal = false;
    let json = false;
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index];
      if (option === "--stage" && stage === undefined) {
        try {
          stage = sanitizeStage(options[index + 1] ?? "");
        } catch {
          return helpError("Use --stage followed by a non-empty stage value.");
        }
        index += 1;
        continue;
      }
      if (option === "--reveal" && !reveal) {
        reveal = true;
        continue;
      }
      if (option === "--json" && !json) {
        json = true;
        continue;
      }
      return helpError(`Unknown world CLI option ${JSON.stringify(option)}.`);
    }
    return {
      kind: "outputs",
      name,
      ...(stage === undefined ? {} : { stage }),
      ...(reveal ? { reveal: true } : {}),
      ...(json ? { json: true } : {}),
    };
  }
  if (command === "list") {
    return args.length === 0 ? { kind: "list" } : helpError("The list command does not take arguments.");
  }
  if (command === "down") {
    const [name, ...options] = args;
    if (!name || name === "--" || name.startsWith("--")) {
      return helpError("The down command needs exactly one world name.");
    }
    let stage: string | undefined;
    let purge = false;
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index];
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
      if (option === "--purge" && !purge) {
        purge = true;
        continue;
      }
      return helpError(`Unknown world CLI option ${JSON.stringify(option)}.`);
    }
    return {
      kind: "down",
      name,
      ...(stage === undefined ? {} : { stage }),
      ...(purge ? { purge: true } : {}),
    };
  }
  if (command === "forget") {
    return args.length === 1 && args[0]
      ? { kind: "forget", name: args[0] }
      : helpError("The forget command needs exactly one world name.");
  }
  return helpError(`Unknown command ${JSON.stringify(command)}. Script worlds support up, attach, outputs, plan, down, list, forget, and help.`);
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function helpText(options: WorldCliOptions): Promise<string> {
  const discovered = await discoverWorlds(options.worldsDirectory);
  const sources = discovered.map((world) => displayWorldPath(world.path, options.cwd));
  return `Usage:
  pnpm world up <script-path-or-name> [--detach] [--timeout <ms>] [--stage <value>] [--place <local|daytona>] [--plain] [-- <script args...>]
  pnpm world attach <name> [--stage <value>] [--plain]
  pnpm world outputs <name> [--stage <value>] [--reveal] [--json]
  pnpm world plan <script-path-or-name> [--stage <value>]
  pnpm world down <name> [--stage <value>] [--purge]
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
  for (const line of formatOutputLines(snapshot.outputs, snapshot.outputMeta ?? {}, { reveal: false })) {
    print(line);
  }
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

const LEDGER_SUFFIX = ".ledger.jsonl";

async function ledgerWorldNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter((name) => name.endsWith(LEDGER_SUFFIX))
      .map((name) => name.slice(0, -LEDGER_SUFFIX.length))
      .sort();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function reapAndReport(
  path: string,
  stagedName: string,
  name: string,
  stage: string | undefined,
  purge: boolean,
  print: (line: string) => void,
  options: WorldCliOptions,
): Promise<ReapReport> {
  const report = await reapLedger(path, {
    cwd: options.cwd,
    purge,
    reapers: { ...builtinReapers, ...options.reapers },
  });
  if (report.reaped.length > 0) {
    print(`Reaped ${report.reaped.length} leaked resources from ${JSON.stringify(stagedName)}.`);
  }
  for (const { entry, reason } of report.skipped) {
    print(`Skipped ${entry.kind} ${entry.id}: ${reason}.`);
  }
  if (report.retained.length > 0 && !purge) {
    print(`Retained ${report.retained.length} resources for ${JSON.stringify(stagedName)}; run pnpm world down ${name}${stage ? ` --stage ${stage}` : ""} --purge to remove them.`);
  }
  return report;
}

function createCliView(
  options: WorldCliOptions,
  flags: { plain?: boolean },
): { view: WorldView; mode: "tty" | "plain" } {
  const detected = detectViewMode(process.env, flags);
  const mode = options.progress || flags.plain
    ? "plain"
    : options.viewMode ?? detected.mode;
  const progress = options.progress ?? ((line: string) => process.stderr.write(`${line}\n`));
  const sink: ViewSink = mode === "plain"
    ? {
        write(text): void {
          progress(text.endsWith("\n") ? text.slice(0, -1) : text);
        },
        isTTY: false,
      }
    : {
        write: (text) => { process.stderr.write(text); },
        isTTY: process.stderr.isTTY === true,
        ...(process.stderr.columns === undefined ? {} : { columns: process.stderr.columns }),
      };
  return {
    mode,
    view: createWorldView({
      sink,
      mode,
      color: mode === "tty" && detected.color,
    }),
  };
}

function reportProgress(options: WorldCliOptions, line: string): void {
  if (options.progress) options.progress(line);
  else process.stderr.write(`${line}\n`);
}

async function finishEventTail(
  path: string,
  tail: { stop(): void },
  rendered: { count: number },
  view: WorldView,
): Promise<WorldEvent[]> {
  tail.stop();
  const events = await readEvents(path);
  for (const event of events.slice(rendered.count)) {
    rendered.count += 1;
    view.apply(event);
  }
  return events;
}

async function resourceCount(path: string): Promise<number> {
  return (await readLedger(path)).length;
}

function lastStepLabel(events: WorldEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "step" && event.status !== "ok") return event.label;
  }
  return undefined;
}

async function stagedReceiptCandidate(
  snapshotDirectory: string,
  name: string,
  stage: string | undefined,
  print: (line: string) => void,
): Promise<{ kind: "found"; stagedName: string; path: string } | { kind: "missing" | "multiple" }> {
  const exactName = receiptName(name, stage);
  const exactPath = scriptWorldSnapshotPath(snapshotDirectory, exactName);
  if (await pathExists(exactPath)) return { kind: "found", stagedName: exactName, path: exactPath };
  if (stage !== undefined) return { kind: "missing" };
  const prefix = `${name}--`;
  const candidates = (await new WorldStateStore(snapshotDirectory).list())
    .map((candidatePath) => basename(candidatePath, extname(candidatePath)))
    .filter((candidate) => candidate.startsWith(prefix))
    .sort();
  if (candidates.length > 1) {
    print(`Multiple staged world receipts match ${JSON.stringify(name)}:`);
    for (const candidate of candidates) print(`  ${candidate}`);
    return { kind: "multiple" };
  }
  return candidates[0]
    ? {
        kind: "found",
        stagedName: candidates[0],
        path: scriptWorldSnapshotPath(snapshotDirectory, candidates[0]),
      }
    : { kind: "missing" };
}

function eventElapsed(events: WorldEvent[]): number {
  if (events.length < 2) return 0;
  const first = Date.parse(events[0]?.t ?? "");
  const ready = [...events].reverse().find((event) => event.type === "ready");
  const last = Date.parse(ready?.t ?? events[events.length - 1]?.t ?? "");
  return Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, last - first) : 0;
}

function planSymbolColor(kind: ScriptReceiptState["kind"]): "green" | "cyan" | "yellow" | "red" {
  if (kind === "create") return "green";
  if (kind === "running") return "cyan";
  if (kind === "changed") return "yellow";
  return "red";
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
      const worldLedgerPath = ledgerPath(snapshotDirectory, stagedName);
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
        await reapAndReport(worldLedgerPath, stagedName, script.name, stage, false, print, options);
        await rm(snapshotPath, { force: true });
        print(`Removed stale world receipt ${JSON.stringify(stagedName)} (pid ${state.snapshot.pid}); recreating.`);
      } else if (await pathExists(worldLedgerPath)) {
        await reapAndReport(worldLedgerPath, stagedName, script.name, stage, false, print, options);
      }
      const logPath = scriptWorldLogPath(snapshotDirectory, stagedName);
      const eventPath = eventsPath(snapshotDirectory, stagedName);
      await rm(eventPath, { force: true });
      const preflight = await runPreflight([nodeCheck(), ...(options.preflight ?? [])]);
      const { view, mode } = createCliView(options, { plain: command.plain });
      view.header({
        name: stagedName,
        ...(stage === undefined ? {} : { stage }),
        ...(command.place === undefined ? {} : { place: command.place }),
        receipt: snapshotPath,
        ...(command.detach || mode === "tty" ? { log: logPath } : {}),
        preflight,
      });
      const startedAt = Date.now();
      const rendered = { count: 0 };
      const tail = tailEvents(eventPath, (event) => {
        rendered.count += 1;
        view.apply(event);
      }, { intervalMs: 50 });
      let childPid: number | undefined;
      let readyShown = false;
      let stopped = false;
      const showReady = async (): Promise<void> => {
        if (readyShown) return;
        const snapshot = await readScriptWorldSnapshot(snapshotPath);
        if (!snapshot) return;
        readyShown = true;
        const events = await readEvents(eventPath);
        for (const event of events.slice(rendered.count)) {
          rendered.count += 1;
          view.apply(event);
        }
        view.ready({
          name: stagedName,
          outputs: snapshot.outputs,
          ...(snapshot.outputMeta === undefined ? {} : { outputMeta: snapshot.outputMeta }),
          elapsedMs: Date.now() - startedAt,
          resources: await resourceCount(worldLedgerPath),
          downHint: `pnpm world down ${script.name}${stage ? ` --stage ${stage}` : ""}`,
          ...(command.detach || mode === "tty" ? { log: logPath } : {}),
        });
      };
      const receiptPoll = setInterval(() => {
        void showReady().catch((error: unknown) => {
          view.apply({ t: new Date().toISOString(), type: "note", text: `Could not read world receipt: ${messageText(error)}` });
        });
      }, 50);
      receiptPoll.unref();
      const onSigint = (): void => {
        if (stopped || childPid === undefined) return;
        stopped = true;
        view.apply({ t: new Date().toISOString(), type: "note", text: "stopping…" });
        try { process.kill(childPid, "SIGINT"); } catch {}
      };
      if (!command.detach && mode === "tty") process.on("SIGINT", onSigint);
      let code: number;
      try {
        code = await launchScriptWorld({
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
          foregroundLog: !command.detach && mode === "tty",
          onSpawn: (pid) => { childPid = pid; },
        });
      } catch (error) {
        clearInterval(receiptPoll);
        if (!command.detach && mode === "tty") process.off("SIGINT", onSigint);
        const events = await finishEventTail(eventPath, tail, rendered, view);
        view.failed({
          name: stagedName,
          ...(lastStepLabel(events) === undefined ? {} : { step: lastStepLabel(events) }),
          elapsedMs: Date.now() - startedAt,
          lastLog: await readLastLogLines(logPath, 40),
          logPath,
          hint: messageText(error),
        });
        view.stop();
        throw error;
      }
      clearInterval(receiptPoll);
      if (!command.detach && mode === "tty") process.off("SIGINT", onSigint);
      const events = await finishEventTail(eventPath, tail, rendered, view);
      await showReady();
      if (code === 0 && events.every((event) => event.type === "ready")) {
        await rm(eventPath, { force: true });
      }
      if (code !== 0) {
        view.failed({
          name: stagedName,
          ...(lastStepLabel(events) === undefined ? {} : { step: lastStepLabel(events) }),
          elapsedMs: Date.now() - startedAt,
          lastLog: await readLastLogLines(logPath, 40),
          logPath,
        });
      } else if (!command.detach) {
        view.stop();
        reportProgress(options, `World ${JSON.stringify(stagedName)} stopped.`);
      } else {
        view.stop();
      }
      return code;
    } catch (error) {
      print(messageText(error));
      return 1;
    }
  }
  if (command.kind === "attach") {
    const snapshotDirectory = scriptWorldSnapshotDirectory(options.cwd);
    const candidate = await stagedReceiptCandidate(
      snapshotDirectory,
      command.name,
      command.stage,
      print,
    );
    if (candidate.kind !== "found") {
      if (candidate.kind === "multiple") return 1;
      print(`World receipt ${JSON.stringify(receiptName(command.name, command.stage))} does not exist.`);
      return 1;
    }
    try {
      const snapshot = await readScriptWorldSnapshot(candidate.path);
      if (!snapshot) {
        print(`World receipt ${JSON.stringify(candidate.stagedName)} does not exist.`);
        return 1;
      }
      const { view, mode } = createCliView(options, { plain: command.plain });
      const eventPath = eventsPath(snapshotDirectory, candidate.stagedName);
      const logPath = scriptWorldLogPath(snapshotDirectory, candidate.stagedName);
      view.header({
        name: candidate.stagedName,
        ...(snapshot.stage === undefined ? {} : { stage: snapshot.stage }),
        ...(snapshot.place === undefined ? {} : { place: snapshot.place }),
        receipt: candidate.path,
        log: logPath,
      });
      const events = await readEvents(eventPath);
      for (const event of events) view.apply(event);
      view.ready({
        name: candidate.stagedName,
        outputs: snapshot.outputs,
        ...(snapshot.outputMeta === undefined ? {} : { outputMeta: snapshot.outputMeta }),
        elapsedMs: eventElapsed(events),
        resources: await resourceCount(ledgerPath(snapshotDirectory, candidate.stagedName)),
        downHint: `pnpm world down ${command.name}${snapshot.stage ? ` --stage ${snapshot.stage}` : ""}`,
        log: logPath,
      });
      if (mode === "plain") {
        view.stop();
        return 0;
      }
      const tail = tailEvents(eventPath, (event) => view.apply(event), { intervalMs: 50 });
      process.stdin.resume();
      await new Promise<void>((done) => {
        let finished = false;
        const finish = (): void => {
          if (finished) return;
          finished = true;
          clearInterval(alivePoll);
          process.off("SIGINT", detach);
          tail.stop();
          view.stop();
          process.stdin.pause();
          done();
        };
        const detach = (): void => finish();
        const alivePoll = setInterval(() => {
          if (isProcessAlive(snapshot.pid)) return;
          reportProgress(options, `World ${JSON.stringify(candidate.stagedName)} stopped.`);
          finish();
        }, 250);
        alivePoll.unref();
        process.once("SIGINT", detach);
      });
      return 0;
    } catch (error) {
      print(messageText(error));
      return 1;
    }
  }
  if (command.kind === "outputs") {
    const snapshotDirectory = scriptWorldSnapshotDirectory(options.cwd);
    const candidate = await stagedReceiptCandidate(
      snapshotDirectory,
      command.name,
      command.stage,
      print,
    );
    if (candidate.kind !== "found") {
      if (candidate.kind === "multiple") return 1;
      print(`World receipt ${JSON.stringify(receiptName(command.name, command.stage))} does not exist.`);
      return 1;
    }
    try {
      const snapshot = await readScriptWorldSnapshot(candidate.path);
      if (!snapshot) {
        print(`World receipt ${JSON.stringify(candidate.stagedName)} does not exist.`);
        return 1;
      }
      const outputMeta = snapshot.outputMeta ?? {};
      if (!command.json) {
        for (const line of formatOutputLines(snapshot.outputs, outputMeta, { reveal: command.reveal === true })) {
          print(line);
        }
        return 0;
      }
      const outputs: Record<string, {
        value: string;
        secret: boolean;
        group?: string;
        note?: string;
      }> = {};
      for (const [key, value] of Object.entries(snapshot.outputs)) {
        const meta = outputMeta[key];
        const isSecret = meta?.secret === true;
        outputs[key] = {
          value: command.reveal || !isSecret ? value : MASK,
          secret: isSecret,
          ...(meta?.group === undefined ? {} : { group: meta.group }),
          ...(meta?.note === undefined ? {} : { note: meta.note }),
        };
      }
      print(JSON.stringify({
        name: candidate.stagedName,
        ...(snapshot.stage === undefined ? {} : { stage: snapshot.stage }),
        alive: isProcessAlive(snapshot.pid),
        outputs,
      }));
      return 0;
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
      const snapshotDirectory = scriptWorldSnapshotDirectory(options.cwd);
      const stagedName = receiptName(script.name, stage);
      const snapshotPath = scriptWorldSnapshotPath(snapshotDirectory, stagedName);
      const state = await classifyScriptReceipt(snapshotPath, recipeHash);
      const labels = {
        create: "+ create",
        running: "• running (attachable)",
        changed: "~ stale (recipe changed)",
        orphaned: "- orphaned (stale receipt, will recreate)",
      };
      const detected = detectViewMode(process.env, {});
      const tty = options.progress === undefined && (options.viewMode ?? detected.mode) === "tty";
      const color = tty && detected.color;
      const label = labels[state.kind];
      print(color ? `${styleText(planSymbolColor(state.kind), label[0] ?? "")} ${label.slice(2)}` : label);
      print(`receipt  ${snapshotPath}`);
      if (state.kind !== "create") printOutputs(state.snapshot, print);
      const worldLedgerPath = ledgerPath(snapshotDirectory, stagedName);
      if (await pathExists(worldLedgerPath)) {
        const entries = await readLedger(worldLedgerPath);
        const leaked = entries.filter((entry) => entry.retain !== true).length;
        const retained = entries.filter((entry) => entry.retain === true).length;
        if (leaked > 0 && (state.kind === "create" || state.kind === "orphaned")) {
          print(`leaked  ${leaked} resources`);
        }
        if (retained > 0) print(`retained  ${retained} resources`);
      }
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
      let worldLedgerPath = ledgerPath(snapshotDirectory, stagedName);
      if (
        command.stage === undefined
        && !await pathExists(path)
        && !await pathExists(worldLedgerPath)
      ) {
        const prefix = `${command.name}--`;
        const receiptCandidates = (await new WorldStateStore(snapshotDirectory).list())
          .map((candidatePath) => basename(candidatePath, extname(candidatePath)))
          .filter((candidate) => candidate.startsWith(prefix));
        const ledgerCandidates = (await ledgerWorldNames(snapshotDirectory))
          .filter((candidate) => candidate.startsWith(prefix));
        const candidates = [...new Set([...receiptCandidates, ...ledgerCandidates])].sort();
        if (candidates.length > 1) {
          print(`Multiple staged world receipts match ${JSON.stringify(command.name)}:`);
          for (const candidate of candidates) print(`  ${candidate}`);
          return 1;
        }
        if (candidates[0]) {
          stagedName = candidates[0];
          path = scriptWorldSnapshotPath(snapshotDirectory, stagedName);
          worldLedgerPath = ledgerPath(snapshotDirectory, stagedName);
        }
      }
      const receiptExists = await pathExists(path);
      const ledgerExists = await pathExists(worldLedgerPath);
      if (!receiptExists) {
        if (!ledgerExists) {
          print(`World receipt ${JSON.stringify(stagedName)} does not exist.`);
          return 1;
        }
        await reapAndReport(
          worldLedgerPath,
          stagedName,
          command.name,
          command.stage,
          command.purge === true,
          print,
          options,
        );
        print(`World ${JSON.stringify(stagedName)} has no receipt; reaped its ledger.`);
        return 0;
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
      await reapAndReport(
        worldLedgerPath,
        stagedName,
        command.name,
        command.stage,
        command.purge === true,
        print,
        options,
      );
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
    const receiptNames = new Set<string>();
    for (const path of await new WorldStateStore(receiptsDirectory).list()) {
      const receiptFileName = basename(path, extname(path));
      receiptNames.add(receiptFileName);
      try {
        const receipt = await readScriptWorldSnapshot(path);
        if (!receipt) continue;
        const alive = isProcessAlive(receipt.pid);
        const entries = await readLedger(ledgerPath(receiptsDirectory, receiptFileName));
        const leaked = entries.filter((entry) => entry.retain !== true).length;
        const retained = entries.filter((entry) => entry.retain === true).length;
        let line = `${receipt.name}  ${receipt.createdAt}  script  ${alive ? "alive" : `dead(pid ${receipt.pid})`}`;
        if (!alive && leaked > 0) line += `  leaked ${leaked}`;
        if (retained > 0) line += `  retained ${retained}`;
        print(line);
        count += 1;
      } catch (error) {
        print(`Warning: skipped ${displayWorldPath(path, options.cwd)}: ${messageText(error)}`);
      }
    }
    for (const stagedName of await ledgerWorldNames(receiptsDirectory)) {
      if (receiptNames.has(stagedName)) continue;
      try {
        const entries = await readLedger(ledgerPath(receiptsDirectory, stagedName));
        const leaked = entries.filter((entry) => entry.retain !== true).length;
        const retained = entries.filter((entry) => entry.retain === true).length;
        if (leaked === 0 && retained === 0) continue;
        let line = `${stagedName}  -  script  down`;
        if (retained > 0) line += `  retained ${retained}`;
        if (leaked > 0) line += `  leaked ${leaked}`;
        print(line);
        count += 1;
      } catch (error) {
        const path = ledgerPath(receiptsDirectory, stagedName);
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
