#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

function parseArgs(argv) {
  const options = {
    file: process.env.UPDATER_MANIFEST_FILE || "",
    url: process.env.UPDATER_ENDPOINT_URL || "",
    platform: process.env.UPDATER_EXPECTED_PLATFORM || "",
    attempts: Number(process.env.UPDATER_VERIFY_ATTEMPTS || "1"),
    delayMs: Number(process.env.UPDATER_VERIFY_DELAY_MS || "1000"),
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
      options.platform = argv[index + 1] || "";
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

  return options;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateUpdaterManifest(manifest, { platform = "" } = {}) {
  const errors = [];

  if (!isRecord(manifest)) {
    return ["manifest must be a JSON object"];
  }

  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    errors.push("version must be a non-empty string");
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
      }
      if (typeof value.signature !== "string" || !value.signature.trim()) {
        errors.push(`platform ${key} must include a non-empty signature`);
      }
    }

    if (platform && !Object.hasOwn(manifest.platforms, platform)) {
      errors.push(`platforms must include ${platform}`);
    }
  }

  return errors;
}

async function fetchUpdaterManifest(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "openwork-release-updater-verify",
    },
    redirect: "follow",
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
        : await fetchUpdaterManifest(options.url);
      const errors = validateUpdaterManifest(manifest, { platform: options.platform });

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
