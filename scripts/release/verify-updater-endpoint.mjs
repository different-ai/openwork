#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

function parsePlatformList(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((platform) => platform.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const options = {
    file: process.env.UPDATER_MANIFEST_FILE || "",
    url: process.env.UPDATER_ENDPOINT_URL || "",
    platforms: parsePlatformList(process.env.UPDATER_EXPECTED_PLATFORM || ""),
    version: process.env.UPDATER_EXPECTED_VERSION || "",
    assetTag: process.env.UPDATER_EXPECTED_ASSET_TAG || "",
    attempts: Number(process.env.UPDATER_VERIFY_ATTEMPTS || "1"),
    delayMs: Number(process.env.UPDATER_VERIFY_DELAY_MS || "1000"),
    timeoutMs: Number(process.env.UPDATER_VERIFY_TIMEOUT_MS || "15000"),
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      options.file = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--url") {
      options.url = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--platform") {
      options.platforms.push(...parsePlatformList(argv[index + 1] || ""));
      index += 1;
      continue;
    }
    if (arg === "--version") {
      options.version = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--asset-tag") {
      options.assetTag = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--attempts") {
      options.attempts = Number(argv[index + 1] || "1");
      index += 1;
      continue;
    }
    if (arg === "--delay-ms") {
      options.delayMs = Number(argv[index + 1] || "1000");
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[index + 1] || "15000");
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.file && !options.url) {
    throw new Error(
      "Missing updater manifest source. Pass --file, --url, or set UPDATER_MANIFEST_FILE/UPDATER_ENDPOINT_URL.",
    );
  }
  if (options.file && options.url) {
    throw new Error("Use either --file or --url, not both.");
  }
  if (!Number.isInteger(options.attempts) || options.attempts < 1) {
    throw new Error("--attempts must be a positive integer.");
  }
  if (!Number.isInteger(options.delayMs) || options.delayMs < 0) {
    throw new Error("--delay-ms must be a non-negative integer.");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("--timeout-ms must be a positive integer.");
  }

  return options;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateUpdaterManifest(manifest, { platform = "", platforms = [], version = "", assetTag = "" } = {}) {
  const errors = [];
  const requiredPlatforms = platforms.length ? platforms : parsePlatformList(platform);
  const expectedVersion = String(version || "").trim().replace(/^v/, "");
  const expectedAssetTag = String(assetTag || "").trim();

  if (!isRecord(manifest)) {
    return ["manifest must be a JSON object"];
  }

  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    errors.push("version must be a non-empty string");
  } else if (expectedVersion && manifest.version.trim().replace(/^v/, "") !== expectedVersion) {
    errors.push(`version must be ${expectedVersion}`);
  }

  if (typeof manifest.pub_date !== "string" || !manifest.pub_date.trim()) {
    errors.push("pub_date must be a non-empty string");
  } else if (Number.isNaN(Date.parse(manifest.pub_date))) {
    errors.push("pub_date must be a valid date string");
  }

  if (!isRecord(manifest.platforms)) {
    errors.push("platforms must be a non-empty object");
  } else {
    const platformEntries = Object.entries(manifest.platforms);
    if (platformEntries.length === 0) {
      errors.push("platforms must contain at least one platform");
    }

    for (const [key, value] of platformEntries) {
      if (!isRecord(value)) {
        errors.push(`platform ${key} must be an object`);
        continue;
      }
      if (typeof value.url !== "string" || !value.url.trim()) {
        errors.push(`platform ${key} must include a non-empty url`);
      } else if (expectedAssetTag && !value.url.includes(`/releases/download/${expectedAssetTag}/`)) {
        errors.push(`platform ${key} url must point at ${expectedAssetTag}`);
      }
      if (typeof value.signature !== "string" || !value.signature.trim()) {
        errors.push(`platform ${key} must include a non-empty signature`);
      }
    }

    for (const requiredPlatform of requiredPlatforms) {
      if (!Object.hasOwn(manifest.platforms, requiredPlatform)) {
        errors.push(`platforms must include ${requiredPlatform}`);
      }
    }
  }

  return errors;
}

async function fetchUpdaterManifest(url, { timeoutMs } = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "openwork-release-updater-verify",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs ?? 15000),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Updater endpoint returned HTTP ${response.status}: ${url}\n${body.slice(0, 400)}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Updater endpoint did not return valid JSON: ${url}\n${body.slice(0, 400)}`);
  }
}

async function readUpdaterManifest(path) {
  const body = await readFile(path, "utf8");
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Updater manifest file did not contain valid JSON: ${path}`);
  }
}

async function main() {
  const options = parseArgs(process.argv);
  let lastError = null;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      const manifest = options.file
        ? await readUpdaterManifest(options.file)
        : await fetchUpdaterManifest(options.url, { timeoutMs: options.timeoutMs });
      const errors = validateUpdaterManifest(manifest, {
        platforms: options.platforms,
        version: options.version,
        assetTag: options.assetTag,
      });

      if (errors.length) {
        throw new Error(`Invalid updater manifest:\n${errors.map((error) => `- ${error}`).join("\n")}`);
      }

      const platformCount = Object.keys(manifest.platforms).length;
      const source = options.file || options.url;
      console.log(`Updater manifest OK: ${manifest.version} (${platformCount} platforms): ${source}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < options.attempts) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Updater endpoint check failed on attempt ${attempt}/${options.attempts}: ${message}`);
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  console.error(`Updater manifest check failed after ${options.attempts} attempt(s): ${message}`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}

export { parseArgs, validateUpdaterManifest };
