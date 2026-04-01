export type DevLogLevel = "debug" | "warn" | "perf";

export type DevLogRecord = {
  id: number;
  at: string;
  ts: number;
  level: DevLogLevel;
  source: string;
  label: string;
  payload?: unknown;
};

type DevRoot = typeof globalThis & {
  __openworkDevLogSeq?: number;
  __openworkDevLogs?: DevLogRecord[];
};

const DEV_LOG_LIMIT = 1500;

const payloadText = (value: unknown) => {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const recordDevLog = (
  enabled: boolean,
  input: {
    level: DevLogLevel;
    source: string;
    label: string;
    payload?: unknown;
  },
) => {
  if (!enabled) return;

  const root = globalThis as DevRoot;
  const id = (root.__openworkDevLogSeq ?? 0) + 1;
  root.__openworkDevLogSeq = id;

  const entry: DevLogRecord = {
    id,
    at: new Date().toISOString(),
    ts: Date.now(),
    level: input.level,
    source: input.source,
    label: input.label,
    payload: input.payload,
  };

  const logs = root.__openworkDevLogs ?? [];
  logs.push(entry);
  if (logs.length > DEV_LOG_LIMIT) {
    logs.splice(0, logs.length - DEV_LOG_LIMIT);
  }
  root.__openworkDevLogs = logs;
};

export const readDevLogs = (limit = 200) => {
  const root = globalThis as DevRoot;
  const logs = root.__openworkDevLogs ?? [];
  if (limit === 0) return logs.slice();
  if (limit < 0) return [];
  if (logs.length <= limit) return logs.slice();
  return logs.slice(logs.length - limit);
};

export const clearDevLogs = () => {
  const root = globalThis as DevRoot;
  root.__openworkDevLogs = [];
  root.__openworkDevLogSeq = 0;
};

export const formatDevLogLine = (entry: DevLogRecord) => {
  const prefix = `[${entry.at}] ${entry.level.toUpperCase()} ${entry.source}:${entry.label}`;
  const text = payloadText(entry.payload);
  return text ? `${prefix} ${text}` : prefix;
};

export const formatDevLogText = (limit = 200) => {
  const lines = readDevLogs(limit).map(formatDevLogLine);
  if (!lines.length) return "";
  return `${lines.join("\n")}\n`;
};
