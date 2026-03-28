#!/usr/bin/env node

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

const DEFAULT_KEY_FILE = join(homedir(), ".config", "openwork", "protected-skills.key");
const DEFAULT_MANIFEST_FILE = join(".openwork", "protected-skills", "manifest.json");
const IGNORED_BASENAMES = new Set([".DS_Store"]);

function usage() {
  console.error(
    "Usage: node scripts/protected-skills/pack.mjs --name <skill-name> --source <dir> --output <bundle.json> [--manifest <path>] [--version <value>] [--description <text>] [--trigger <text>] [--key-file <path>]",
  );
}

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function validateSkillName(input) {
  const name = String(input ?? "").trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Invalid skill name: ${name || "(empty)"}`);
  }
  return name;
}

function normalizeOptionalText(input) {
  const value = String(input ?? "").trim();
  return value || null;
}

function normalizeRelativePath(input) {
  return String(input ?? "").replace(/\\/g, "/");
}

function defaultVersionTag(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    String(date.getUTCFullYear()),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
  ].join("") + "-" + [
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

async function readManifest(path) {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...(parsed && typeof parsed === "object" ? parsed : {}),
      schemaVersion: typeof parsed?.schemaVersion === "number" ? parsed.schemaVersion : 1,
      skills: Array.isArray(parsed?.skills) ? parsed.skills : [],
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { schemaVersion: 1, skills: [] };
    }
    throw error;
  }
}

async function ensureKeyFile(path) {
  const resolved = resolve(path);
  try {
    const raw = (await readFile(resolved, "utf8")).trim();
    if (!raw) {
      throw new Error("Key file is empty");
    }
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) {
      throw new Error("Protected skill key must decode to 32 bytes");
    }
    return { key, created: false, path: resolved };
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  const key = randomBytes(32);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, `${key.toString("base64")}\n`, "utf8");
  await chmod(resolved, 0o600).catch(() => {});
  return { key, created: true, path: resolved };
}

async function collectFiles(sourceDir) {
  const base = resolve(sourceDir);
  const entries = await readdir(base, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED_BASENAMES.has(entry.name)) {
      continue;
    }
    const entryPath = join(base, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
      continue;
    }
    if (!entry.isFile()) continue;
    const content = await readFile(entryPath, "utf8");
    files.push({
      absolutePath: entryPath,
      content,
    });
  }

  return files;
}

async function collectFilesRelative(sourceDir) {
  const base = resolve(sourceDir);
  const nested = await collectFiles(base);
  return nested.map((file) => ({
    path: relative(base, file.absolutePath).replace(/\\/g, "/"),
    content: file.content.endsWith("\n") ? file.content : `${file.content}\n`,
  }));
}

async function main() {
  const name = validateSkillName(readArg("--name"));
  const source = readArg("--source");
  const output = readArg("--output");
  const manifestArg = readArg("--manifest");
  const explicitVersion = normalizeOptionalText(readArg("--version"));
  const explicitDescription = normalizeOptionalText(readArg("--description"));
  const explicitTrigger = normalizeOptionalText(readArg("--trigger"));
  const keyFile = readArg("--key-file") || DEFAULT_KEY_FILE;

  if (!source || !output) {
    usage();
    process.exitCode = 1;
    return;
  }

  const sourceDir = resolve(source);
  const outputPath = resolve(output);
  const manifestPath = resolve(manifestArg || DEFAULT_MANIFEST_FILE);
  const sourceStat = await stat(sourceDir).catch(() => null);
  if (!sourceStat?.isDirectory()) {
    throw new Error(`Source directory not found: ${sourceDir}`);
  }

  const files = await collectFilesRelative(sourceDir);
  if (!files.length) {
    throw new Error(`No files found in ${sourceDir}`);
  }

  const packedAt = new Date();
  const payloadData = {
    schemaVersion: 1,
    name,
    packedAt: packedAt.toISOString(),
    files,
  };
  const payload = Buffer.from(JSON.stringify(payloadData), "utf8");
  const checksum = createHash("sha256").update(payload).digest("hex");
  const manifest = await readManifest(manifestPath);
  const existingEntries = manifest.skills.filter((entry) => entry && typeof entry === "object");
  const existingEntry = existingEntries.find((entry) => String(entry.name ?? "").trim() === name) ?? null;

  let description = explicitDescription;
  if (!description && existingEntry) {
    description = normalizeOptionalText(existingEntry.description);
  }
  let trigger = explicitTrigger;
  if (!trigger && existingEntry) {
    trigger = normalizeOptionalText(existingEntry.trigger);
  }
  if (!existingEntry && !description) {
    throw new Error(`Manifest entry not found for ${name}. Provide --description for the first pack.`);
  }

  const { key, created, path: resolvedKeyFile } = await ensureKeyFile(keyFile);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  const bundle = {
    schemaVersion: 1,
    name,
    algorithm: "aes-256-gcm",
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

  const unchanged = existingEntry?.checksum === checksum;
  const version = explicitVersion || (unchanged ? normalizeOptionalText(existingEntry?.version) : null) || defaultVersionTag(packedAt);
  const publishedAt = unchanged
    ? normalizeOptionalText(existingEntry?.publishedAt) || packedAt.toISOString()
    : packedAt.toISOString();
  const bundlePath = normalizeRelativePath(relative(process.cwd(), outputPath));
  const nextEntry = {
    ...(existingEntry && typeof existingEntry === "object" ? existingEntry : {}),
    name,
    description,
    trigger,
    bundlePath,
    version,
    publishedAt,
    checksum,
  };
  const nextSkills = existingEntries.filter((entry) => String(entry.name ?? "").trim() !== name);
  nextSkills.push(nextEntry);
  nextSkills.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));

  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, schemaVersion: 1, skills: nextSkills }, null, 2)}\n`,
    "utf8",
  );

  console.log(`Packed protected skill ${name}`);
  console.log(`Source: ${sourceDir}`);
  console.log(`Output: ${outputPath}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Files: ${files.length}`);
  console.log(`Checksum (sha256): ${checksum}`);
  console.log(`Version: ${version}`);
  console.log(`Published at: ${publishedAt}`);
  console.log(`Key file: ${resolvedKeyFile}${created ? " (created)" : ""}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
