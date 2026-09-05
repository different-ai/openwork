import { styleText } from "node:util";
import type { WorldEvent } from "./events.ts";
import { formatOutputLines, type OutputMeta } from "./outputs.ts";
import type { PreflightResult } from "./preflight.ts";

export interface ViewSink {
  write(text: string): void;
  isTTY: boolean;
  columns?: number;
}

export interface WorldView {
  header(input: {
    name: string;
    stage?: string;
    place?: string;
    receipt: string;
    log?: string;
    preflight?: PreflightResult[];
  }): void;
  apply(event: WorldEvent): void;
  ready(input: {
    name: string;
    outputs: Record<string, string>;
    outputMeta?: Record<string, OutputMeta>;
    elapsedMs: number;
    resources: number;
    downHint: string;
    log?: string;
  }): void;
  failed(input: {
    name: string;
    step?: string;
    elapsedMs: number;
    lastLog: string[];
    logPath: string;
    hint?: string;
  }): void;
  stop(): void;
}

interface StepRow {
  id: string;
  label: string;
  status: "start" | "ok" | "fail";
  startedAt: number;
  updatedAt: number;
  lastHeartbeatAt: number;
  detail?: string;
  log?: string;
}

const SPINNER = ["◐", "◓", "◑", "◒"];

export function formatElapsed(elapsedMs: number): string {
  if (elapsedMs < 100) return "<0.1s";
  if (elapsedMs < 60_000) return `${(elapsedMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(elapsedMs / 60_000);
  const seconds = Math.floor((elapsedMs % 60_000) / 1_000).toString().padStart(2, "0");
  return `${minutes}m ${seconds}s`;
}

function eventTime(event: WorldEvent, fallback: number): number {
  const parsed = Date.parse(event.t);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function createWorldView(options: {
  sink: ViewSink;
  mode: "tty" | "plain";
  color: boolean;
  now?: () => number;
  heartbeatMs?: number;
  spinnerMs?: number;
}): WorldView {
  const now = options.now ?? Date.now;
  const configuredHeartbeat = Number(process.env.OPENWORK_WORLD_HEARTBEAT_MS);
  const heartbeatMs = options.heartbeatMs
    ?? (Number.isFinite(configuredHeartbeat) && configuredHeartbeat > 0 ? configuredHeartbeat : 20_000);
  const spinnerMs = options.spinnerMs ?? 100;
  const steps: StepRow[] = [];
  const resources: Array<{ kind: string; id: string; label?: string }> = [];
  const notes: string[] = [];
  let headerLines: string[] = [];
  let renderedLines = 0;
  let spinnerFrame = 0;
  let stopped = false;
  let terminalFrame: string[] | undefined;

  const paint = (style: Parameters<typeof styleText>[0], text: string): string => (
    options.color ? styleText(style, text) : text
  );
  const writeLine = (line: string): void => options.sink.write(`${line}\n`);

  const waitingDetail = (step: StepRow): string | undefined => {
    const waiting = now() - step.updatedAt;
    if (step.status !== "start" || waiting < heartbeatMs) return undefined;
    return `still waiting (${formatElapsed(waiting)})${step.log ? ` · log ${step.log}` : ""}`;
  };

  const ttyLines = (): string[] => {
    if (terminalFrame) return terminalFrame;
    const lines = [...headerLines];
    for (const step of steps) {
      const elapsed = formatElapsed((step.status === "start" ? now() : step.updatedAt) - step.startedAt);
      if (step.status === "start") {
        const waiting = waitingDetail(step);
        const suffix = waiting
          ? paint("yellow", `  ${waiting}`)
          : step.detail ? `  ${step.detail}` : "";
        lines.push(`${paint("cyan", SPINNER[spinnerFrame % SPINNER.length])} ${step.label}${suffix}`);
      } else if (step.status === "ok") {
        lines.push(`${paint("green", "✔")} ${step.label} (${elapsed})${step.detail ? `  ${step.detail}` : ""}`);
      } else {
        lines.push(`${paint("red", "✖")} ${step.label}${step.detail ? ` — ${step.detail}` : ""}`);
      }
    }
    for (const resource of resources) {
      lines.push(`${paint("green", "+")} ${resource.kind}  ${resource.label ? `${resource.label} ` : ""}${resource.id}`);
    }
    for (const note of notes) lines.push(`${paint("cyan", "·")} ${note}`);
    return lines;
  };

  const redraw = (): void => {
    if (options.mode !== "tty" || stopped) return;
    const lines = ttyLines();
    let output = renderedLines > 0 ? `\u001b[${renderedLines}A` : "";
    for (const line of lines) output += `\r\u001b[2K${line}\n`;
    for (let index = lines.length; index < renderedLines; index += 1) output += "\r\u001b[2K\n";
    if (renderedLines > lines.length) output += `\u001b[${renderedLines - lines.length}A`;
    renderedLines = lines.length;
    options.sink.write(output);
  };

  const spinner = setInterval(() => {
    if (!steps.some((step) => step.status === "start")) return;
    spinnerFrame += 1;
    redraw();
  }, spinnerMs);
  spinner.unref();

  const heartbeat = setInterval(() => {
    const step = [...steps].reverse().find((candidate) => candidate.status === "start");
    if (!step) return;
    const current = now();
    if (current - step.updatedAt < heartbeatMs || current - step.lastHeartbeatAt < heartbeatMs) return;
    step.lastHeartbeatAt = current;
    if (options.mode === "plain") {
      writeLine(`… still waiting on ${JSON.stringify(step.label)} (${formatElapsed(current - step.updatedAt)})${step.log ? ` · log ${step.log}` : ""}`);
    } else {
      redraw();
    }
  }, Math.min(heartbeatMs, 1_000));
  heartbeat.unref();

  const finish = (): void => {
    clearInterval(spinner);
    clearInterval(heartbeat);
  };

  return {
    header(input): void {
      const identity = [
        `world  ${input.name}`,
        ...(input.stage ? [`stage ${input.stage}`] : []),
        ...(input.place ? [`place ${input.place}`] : []),
      ].join("  ");
      headerLines = [
        paint("bold", identity),
        `receipt  ${input.receipt}`,
        ...(input.log ? [`log  ${input.log}`] : []),
      ];
      if (input.preflight && input.preflight.length > 0) {
        headerLines.push(`preflight  ${input.preflight.map((result) => (
          `${result.label} ${paint(result.ok ? "green" : "yellow", result.ok ? "✔" : "✖")}`
        )).join("  ")}`);
        for (const result of input.preflight) {
          if (result.ok) continue;
          headerLines.push(`${paint("yellow", "⚠")} ${result.label}${result.detail ? ` ${result.detail}` : ""}${result.hint ? ` — ${result.hint}` : ""}`);
        }
      }
      if (options.mode === "plain") {
        for (const line of headerLines) writeLine(line);
      } else {
        redraw();
      }
    },
    apply(event): void {
      if (stopped) return;
      if (event.type === "step") {
        const current = now();
        const existing = steps.find((step) => step.id === event.id);
        if (existing) {
          const recorded = eventTime(event, current);
          existing.label = event.label;
          existing.status = event.status;
          existing.updatedAt = recorded;
          existing.lastHeartbeatAt = current;
          existing.detail = event.detail;
          existing.log = event.log ?? existing.log;
        } else {
          const recorded = eventTime(event, current);
          steps.push({
            id: event.id,
            label: event.label,
            status: event.status,
            startedAt: recorded,
            updatedAt: current,
            lastHeartbeatAt: current,
            ...(event.detail === undefined ? {} : { detail: event.detail }),
            ...(event.log === undefined ? {} : { log: event.log }),
          });
        }
        if (options.mode === "plain") {
          if (event.status === "start") writeLine(`▸ ${event.label}`);
          else if (event.status === "ok") {
            const step = steps.find((candidate) => candidate.id === event.id);
            writeLine(`✔ ${event.label} (${formatElapsed(step ? step.updatedAt - step.startedAt : 0)})`);
          } else writeLine(`✖ ${event.label}${event.detail ? ` — ${event.detail}` : ""}`);
        } else {
          redraw();
        }
        return;
      }
      if (event.type === "resource") {
        resources.push({
          kind: event.kind,
          id: event.id,
          ...(event.label === undefined ? {} : { label: event.label }),
        });
        if (options.mode === "plain") {
          writeLine(`+ ${event.kind}  ${event.label ? `${event.label} ` : ""}${event.id}`);
        } else {
          redraw();
        }
        return;
      }
      if (event.type === "note") {
        notes.push(event.text);
        if (options.mode === "plain") writeLine(`· ${event.text}`);
        else redraw();
      }
    },
    ready(input): void {
      finish();
      const lines = [`${paint("green", "✔")} ${input.name} is up${options.mode === "tty" ? "  " : " "}(${formatElapsed(input.elapsedMs)} · ${input.resources} resources)`];
      const outputMeta = input.outputMeta ?? {};
      lines.push(...formatOutputLines(input.outputs, outputMeta, { reveal: false }));
      const hasSecrets = Object.values(outputMeta).some((meta) => meta.secret === true);
      const revealHint = input.downHint.replace("pnpm world down", "pnpm world outputs");
      lines.push(`Ctrl-C to stop · ${input.downHint}${input.log ? ` · log ${input.log}` : ""}${hasSecrets ? ` · secrets: ${revealHint} --reveal` : ""}`);
      if (options.mode === "plain") {
        for (const line of lines) writeLine(line);
      } else {
        terminalFrame = lines;
        redraw();
      }
    },
    failed(input): void {
      finish();
      const lines = [
        `${paint("red", "✖")} ${input.name} failed${input.step ? ` at ${JSON.stringify(input.step)}` : ""} (${formatElapsed(input.elapsedMs)})`,
        `last ${input.lastLog.length} lines of ${input.logPath}:`,
        ...input.lastLog.map((line) => `  ${line}`),
        ...(input.hint ? [`hint: ${input.hint}`] : []),
      ];
      if (options.mode === "plain") {
        for (const line of lines) writeLine(line);
      } else {
        terminalFrame = lines;
        redraw();
      }
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      finish();
    },
  };
}

export function detectViewMode(
  env: NodeJS.ProcessEnv,
  flags: { plain?: boolean },
): { mode: "tty" | "plain"; color: boolean } {
  const tty = process.stderr.isTTY === true
    && !flags.plain
    && !env.CI
    && env.NO_COLOR === undefined
    && env.TERM !== "dumb";
  return { mode: tty ? "tty" : "plain", color: tty };
}
