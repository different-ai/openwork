import type { Dirent } from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseLegacyTestRunJson, parseTestRunJson } from "./schema.ts";
import type { TestRunRecord } from "./schema.ts";

export type StoredTestRunFormat = "current" | "legacy";

export interface RecordedTestRunEntry {
  kind: "test-run";
  format: StoredTestRunFormat;
  directoryName: string;
  directoryPath: string;
  name: string;
  createdAt: string;
  href: string;
  thumbnailHref?: string;
  testRun: TestRunRecord;
}

export interface LegacyArtifactEntry {
  kind: "legacy-artifacts";
  directoryName: string;
  directoryPath: string;
  name: string;
  createdAt: string;
  href: string;
  thumbnailHref?: string;
  pngFiles: string[];
}

export type TestArtifactIndexEntry = RecordedTestRunEntry | LegacyArtifactEntry;

export interface ReadTestRunResult {
  format: StoredTestRunFormat;
  testRun: TestRunRecord;
}

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

async function readStoredTestRun(path: string, format: StoredTestRunFormat): Promise<TestRunRecord | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return null;
    const raw = await readFile(path, "utf8");
    const value: unknown = JSON.parse(raw);
    return format === "current" ? parseTestRunJson(value) : parseLegacyTestRunJson(value);
  } catch {
    return null;
  }
}

export async function readTestRunFile(path: string): Promise<TestRunRecord | null> {
  return readStoredTestRun(path, "current");
}

export async function readTestRunDirectory(directoryPath: string): Promise<ReadTestRunResult | null> {
  const current = await readStoredTestRun(join(directoryPath, "test-run.json"), "current");
  if (current) return { format: "current", testRun: current };
  const legacy = await readStoredTestRun(join(directoryPath, "roll.json"), "legacy");
  return legacy ? { format: "legacy", testRun: legacy } : null;
}

async function scanRecordedTestRuns(resultsDir: string): Promise<RecordedTestRunEntry[]> {
  const testRunsDir = join(resultsDir, "test-runs");
  const directories = (await readDirectory(testRunsDir)).filter((entry) => entry.isDirectory());
  const testRuns: RecordedTestRunEntry[] = [];
  for (const directory of directories) {
    const directoryPath = join(testRunsDir, directory.name);
    const testRun = await readStoredTestRun(join(directoryPath, "test-run.json"), "current");
    if (!testRun) continue;
    const firstScreenshot = testRun.artifacts.find((artifact) => artifact.fileName.length > 0);
    testRuns.push({
      kind: "test-run",
      format: "current",
      directoryName: directory.name,
      directoryPath,
      name: testRun.name,
      createdAt: testRun.createdAt,
      href: `${segment(directory.name)}/index.html`,
      thumbnailHref: firstScreenshot ? `${segment(directory.name)}/${segment(firstScreenshot.fileName)}` : undefined,
      testRun,
    });
  }
  return testRuns;
}

async function scanLegacyTestRuns(resultsDir: string): Promise<RecordedTestRunEntry[]> {
  const legacyDir = join(resultsDir, "rolls");
  const directories = (await readDirectory(legacyDir)).filter((entry) => entry.isDirectory());
  const testRuns: RecordedTestRunEntry[] = [];
  for (const directory of directories) {
    const directoryPath = join(legacyDir, directory.name);
    const testRun = await readStoredTestRun(join(directoryPath, "roll.json"), "legacy");
    if (!testRun) continue;
    const firstScreenshot = testRun.artifacts.find((artifact) => artifact.fileName.length > 0);
    testRuns.push({
      kind: "test-run",
      format: "legacy",
      directoryName: directory.name,
      directoryPath,
      name: testRun.name,
      createdAt: testRun.createdAt,
      href: `../rolls/${segment(directory.name)}/index.html`,
      thumbnailHref: firstScreenshot ? `../rolls/${segment(directory.name)}/${segment(firstScreenshot.fileName)}` : undefined,
      testRun,
    });
  }
  return testRuns;
}

async function scanLooseLegacyArtifacts(resultsDir: string): Promise<LegacyArtifactEntry[]> {
  const directories = (await readDirectory(resultsDir))
    .filter((entry) => entry.isDirectory() && entry.name !== "test-runs" && entry.name !== "rolls" && !entry.name.startsWith("."));
  const legacyArtifacts: LegacyArtifactEntry[] = [];
  for (const directory of directories) {
    const directoryPath = join(resultsDir, directory.name);
    const contents = await readDirectory(directoryPath);
    // fraimz.html is the frozen legacy-runner report filename.
    const hasLegacyReport = contents.some((entry) => entry.isFile() && entry.name === "fraimz.html");
    const pngFiles = contents
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
      .map((entry) => entry.name)
      .sort();
    if (!hasLegacyReport && pngFiles.length === 0) continue;
    const info = await stat(directoryPath);
    const createdAt = timestampFromName(directory.name) ?? info.mtime.toISOString();
    const firstPng = pngFiles[0];
    const prefix = `../${segment(directory.name)}/`;
    legacyArtifacts.push({
      kind: "legacy-artifacts",
      directoryName: directory.name,
      directoryPath,
      name: basename(directoryPath),
      createdAt,
      href: `${prefix}${hasLegacyReport ? "fraimz.html" : segment(firstPng ?? "")}`,
      thumbnailHref: firstPng ? `${prefix}${segment(firstPng)}` : undefined,
      pngFiles,
    });
  }
  return legacyArtifacts;
}

export async function scanTestRuns(resultsDir: string): Promise<TestArtifactIndexEntry[]> {
  const entries = [
    ...await scanRecordedTestRuns(resultsDir),
    ...await scanLegacyTestRuns(resultsDir),
    ...await scanLooseLegacyArtifacts(resultsDir),
  ];
  return entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
