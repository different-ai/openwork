import { appendFile, chmod, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OutputMeta } from "./outputs.ts";

export const EVENTS_ENV = "OPENWORK_WORLD_EVENTS";

export function eventsPath(snapshotDirectory: string, receiptName: string): string {
  return join(snapshotDirectory, `${receiptName}.events.jsonl`);
}

export type WorldEvent = { t: string } & (
  | {
      type: "step";
      id: string;
      label: string;
      status: "start" | "ok" | "fail";
      detail?: string;
      log?: string;
    }
  | { type: "resource"; kind: string; id: string; label?: string }
  | { type: "ready"; outputs: Record<string, string>; outputMeta?: Record<string, OutputMeta> }
  | { type: "note"; text: string }
);

export interface StepHandle {
  ok(detail?: string): Promise<void>;
  fail(detail?: string): Promise<void>;
  note(detail: string): Promise<void>;
}

export interface Progress {
  step(id: string, label: string, options?: { log?: string }): StepHandle;
  note(text: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined | false {
  const entry = value[key];
  return entry === undefined || typeof entry === "string" ? entry : false;
}

function parseOutputMeta(value: unknown): Record<string, OutputMeta> | false {
  if (!isRecord(value)) return false;
  const outputMeta: Record<string, OutputMeta> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      !isRecord(entry)
      || Object.keys(entry).some((name) => name !== "secret" && name !== "group" && name !== "note")
      || (entry.secret !== undefined && typeof entry.secret !== "boolean")
      || (entry.group !== undefined && typeof entry.group !== "string")
      || (entry.note !== undefined && typeof entry.note !== "string")
    ) return false;
    outputMeta[key] = {
      ...(typeof entry.secret === "boolean" ? { secret: entry.secret } : {}),
      ...(typeof entry.group === "string" ? { group: entry.group } : {}),
      ...(typeof entry.note === "string" ? { note: entry.note } : {}),
    };
  }
  return outputMeta;
}

function parseEvent(line: string): WorldEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.t !== "string" || typeof value.type !== "string") return undefined;
  if (value.type === "step") {
    const detail = optionalString(value, "detail");
    const log = optionalString(value, "log");
    if (
      typeof value.id !== "string"
      || typeof value.label !== "string"
      || (value.status !== "start" && value.status !== "ok" && value.status !== "fail")
      || detail === false
      || log === false
    ) return undefined;
    return {
      t: value.t,
      type: "step",
      id: value.id,
      label: value.label,
      status: value.status,
      ...(detail === undefined ? {} : { detail }),
      ...(log === undefined ? {} : { log }),
    };
  }
  if (value.type === "resource") {
    const label = optionalString(value, "label");
    if (typeof value.kind !== "string" || typeof value.id !== "string" || label === false) return undefined;
    return {
      t: value.t,
      type: "resource",
      kind: value.kind,
      id: value.id,
      ...(label === undefined ? {} : { label }),
    };
  }
  if (value.type === "ready") {
    if (!isRecord(value.outputs) || !Object.values(value.outputs).every((entry) => typeof entry === "string")) {
      return undefined;
    }
    const outputs: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value.outputs)) {
      if (typeof entry === "string") outputs[key] = entry;
    }
    const outputMeta = value.outputMeta === undefined ? undefined : parseOutputMeta(value.outputMeta);
    if (outputMeta === false) return undefined;
    return {
      t: value.t,
      type: "ready",
      outputs,
      ...(outputMeta === undefined ? {} : { outputMeta }),
    };
  }
  if (value.type === "note" && typeof value.text === "string") {
    return { t: value.t, type: "note", text: value.text };
  }
  return undefined;
}

function parseLines(text: string): WorldEvent[] {
  const events: WorldEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const event = parseEvent(line);
    if (event) events.push(event);
  }
  return events;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export async function appendEvent(path: string, event: WorldEvent): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readEvents(path: string): Promise<WorldEvent[]> {
  try {
    return parseLines(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

export function tailEvents(
  path: string,
  onEvent: (event: WorldEvent) => void,
  options: { intervalMs: number },
): { stop(): void } {
  let stopped = false;
  let offset = 0;
  let remainder = "";
  let polling = false;

  const poll = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    try {
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch (error) {
        if (isMissingFile(error)) {
          offset = 0;
          remainder = "";
          return;
        }
        throw error;
      }
      if (size < offset) {
        offset = 0;
        remainder = "";
      }
      if (size === offset) return;
      const bytes = await readFile(path);
      if (bytes.length < offset) {
        offset = 0;
        remainder = "";
      }
      const added = bytes.subarray(offset).toString("utf8");
      offset = bytes.length;
      const text = remainder + added;
      const completeThrough = text.lastIndexOf("\n");
      if (completeThrough === -1) {
        remainder = text;
        return;
      }
      remainder = text.slice(completeThrough + 1);
      for (const event of parseLines(text.slice(0, completeThrough))) onEvent(event);
    } finally {
      polling = false;
    }
  };

  const timer = setInterval(() => { void poll().catch(() => {}); }, options.intervalMs);
  timer.unref();
  void poll().catch(() => {});
  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function timestamp(): string {
  return new Date().toISOString();
}

function noOpStep(): StepHandle {
  return {
    ok: () => Promise.resolve(),
    fail: () => Promise.resolve(),
    note: () => Promise.resolve(),
  };
}

export function progress(): Progress {
  const path = process.env[EVENTS_ENV];
  if (path === undefined) {
    return { step: noOpStep, note: () => Promise.resolve() };
  }

  let writes = Promise.resolve();
  const emit = (event: WorldEvent): Promise<void> => {
    writes = writes.then(() => appendEvent(path, event));
    return writes;
  };
  return {
    step(id, label, options = {}): StepHandle {
      void emit({
        t: timestamp(),
        type: "step",
        id,
        label,
        status: "start",
        ...(options.log === undefined ? {} : { log: options.log }),
      });
      return {
        ok: (detail) => emit({
          t: timestamp(),
          type: "step",
          id,
          label,
          status: "ok",
          ...(detail === undefined ? {} : { detail }),
          ...(options.log === undefined ? {} : { log: options.log }),
        }),
        fail: (detail) => emit({
          t: timestamp(),
          type: "step",
          id,
          label,
          status: "fail",
          ...(detail === undefined ? {} : { detail }),
          ...(options.log === undefined ? {} : { log: options.log }),
        }),
        note: (detail) => emit({ t: timestamp(), type: "note", text: detail }),
      };
    },
    note: (text) => emit({ t: timestamp(), type: "note", text }),
  };
}
