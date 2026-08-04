import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Dirent } from "node:fs";
import { parseRollJson } from "./schema.ts";
import type { PhotoRollRecord } from "./schema.ts";

export interface RecordedRollEntry {
  kind: "roll";
  directoryName: string;
  directoryPath: string;
  name: string;
  createdAt: string;
  href: string;
  thumbnailHref?: string;
  roll: PhotoRollRecord;
}

export interface LegacyRollEntry {
  kind: "legacy";
  directoryName: string;
  directoryPath: string;
  name: string;
  createdAt: string;
  href: string;
  thumbnailHref?: string;
  pngFiles: string[];
}

export type RollEntry = RecordedRollEntry | LegacyRollEntry;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function readDirectory(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function timestampFromName(name: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
  if (!match) return null;
  const [, date, hour, minute, second, millis] = match;
  if (!date || !hour || !minute || !second || !millis) return null;
  const timestamp = `${date}${hour}:${minute}:${second}.${millis}Z`;
  return Number.isNaN(Date.parse(timestamp)) ? null : timestamp;
}

export async function readRollFile(path: string): Promise<PhotoRollRecord | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return null;
    const raw = await readFile(path, "utf8");
    const value: unknown = JSON.parse(raw);
    return parseRollJson(value);
  } catch {
    return null;
  }
}

async function scanRecordedRolls(resultsDir: string): Promise<RecordedRollEntry[]> {
  const rollsDir = join(resultsDir, "rolls");
  const directories = (await readDirectory(rollsDir)).filter((entry) => entry.isDirectory());
  const rolls: RecordedRollEntry[] = [];
  for (const directory of directories) {
    const directoryPath = join(rollsDir, directory.name);
    const roll = await readRollFile(join(directoryPath, "roll.json"));
    if (!roll) continue;
    const firstFrame = roll.frames.find((frame) => frame.fileName.length > 0);
    rolls.push({
      kind: "roll",
      directoryName: directory.name,
      directoryPath,
      name: roll.name,
      createdAt: roll.createdAt,
      href: `${segment(directory.name)}/index.html`,
      thumbnailHref: firstFrame ? `${segment(directory.name)}/${segment(firstFrame.fileName)}` : undefined,
      roll,
    });
  }
  return rolls;
}

async function scanLegacyRolls(resultsDir: string): Promise<LegacyRollEntry[]> {
  const directories = (await readDirectory(resultsDir))
    .filter((entry) => entry.isDirectory() && entry.name !== "rolls" && !entry.name.startsWith("."));
  const legacy: LegacyRollEntry[] = [];
  for (const directory of directories) {
    const directoryPath = join(resultsDir, directory.name);
    const contents = await readDirectory(directoryPath);
    const hasFraimz = contents.some((entry) => entry.isFile() && entry.name === "fraimz.html");
    const pngFiles = contents
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
      .map((entry) => entry.name)
      .sort();
    if (!hasFraimz && pngFiles.length === 0) continue;
    const info = await stat(directoryPath);
    const createdAt = timestampFromName(directory.name) ?? info.mtime.toISOString();
    const firstPng = pngFiles[0];
    const prefix = `../${segment(directory.name)}/`;
    legacy.push({
      kind: "legacy",
      directoryName: directory.name,
      directoryPath,
      name: basename(directoryPath),
      createdAt,
      href: `${prefix}${hasFraimz ? "fraimz.html" : segment(firstPng ?? "")}`,
      thumbnailHref: firstPng ? `${prefix}${segment(firstPng)}` : undefined,
      pngFiles,
    });
  }
  return legacy;
}

export async function scanRolls(resultsDir: string): Promise<RollEntry[]> {
  const entries = [
    ...await scanRecordedRolls(resultsDir),
    ...await scanLegacyRolls(resultsDir),
  ];
  return entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
