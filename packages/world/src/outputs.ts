export interface OutputMeta {
  secret?: boolean;
  group?: string;
  note?: string;
}

export type WorldOutput = string | ({ value: string } & OutputMeta);

export const MASK = "••••••••";

export function output(value: string, meta?: Omit<OutputMeta, "secret">): WorldOutput {
  return { value, ...meta };
}

export function secret(value: string, meta?: Omit<OutputMeta, "secret">): WorldOutput {
  return { value, secret: true, ...meta };
}

export function normalizeOutputs(outputs: Record<string, WorldOutput>): {
  values: Record<string, string>;
  meta: Record<string, OutputMeta>;
} {
  const values: Record<string, string> = {};
  const meta: Record<string, OutputMeta> = {};
  for (const [key, entry] of Object.entries(outputs)) {
    if (typeof entry === "string") {
      values[key] = entry;
      continue;
    }
    values[key] = entry.value;
    const entryMeta: OutputMeta = {};
    if (entry.secret !== undefined) entryMeta.secret = entry.secret;
    if (entry.group !== undefined) entryMeta.group = entry.group;
    if (entry.note !== undefined) entryMeta.note = entry.note;
    if (Object.keys(entryMeta).length > 0) meta[key] = entryMeta;
  }
  return { values, meta };
}

export function maskOutputs(
  values: Record<string, string>,
  meta: Record<string, OutputMeta>,
): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    masked[key] = meta[key]?.secret === true ? MASK : value;
  }
  return masked;
}

export function formatOutputLines(
  values: Record<string, string>,
  meta: Record<string, OutputMeta>,
  options: { reveal: boolean },
): string[] {
  const entries = Object.entries(values);
  const shown = options.reveal ? values : maskOutputs(values, meta);
  if (!entries.some(([key]) => meta[key]?.group !== undefined)) {
    return entries.map(([key]) => `${key}  ${shown[key]}`);
  }

  const ungrouped: Array<[string, string]> = [];
  const groups = new Map<string, Array<[string, string]>>();
  for (const entry of entries) {
    const group = meta[entry[0]]?.group;
    if (group === undefined) {
      ungrouped.push(entry);
      continue;
    }
    const groupEntries = groups.get(group) ?? [];
    groupEntries.push(entry);
    groups.set(group, groupEntries);
  }

  const lines: string[] = [];
  const appendBlock = (block: Array<[string, string]>, indent: string): void => {
    const width = Math.max(...block.map(([key]) => key.length));
    for (const [key] of block) {
      const note = meta[key]?.note;
      lines.push(`${indent}${key.padEnd(width)}  ${shown[key]}${note === undefined ? "" : `  ${note}`}`);
    }
  };
  if (ungrouped.length > 0) appendBlock(ungrouped, "");
  for (const [group, groupEntries] of groups) {
    lines.push(group);
    appendBlock(groupEntries, "  ");
  }
  return lines;
}
