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
    kind: process.env.UPDATER_MANIFEST_KIND || "tauri-json",
    file: process.env.UPDATER_MANIFEST_FILE || "",
    url: process.env.UPDATER_ENDPOINT_URL || "",
    platforms: parsePlatformList(process.env.UPDATER_EXPECTED_PLATFORM || ""),
    version: process.env.UPDATER_EXPECTED_VERSION || "",
    assetTag: process.env.UPDATER_EXPECTED_ASSET_TAG || "",
    assets: parsePlatformList(process.env.UPDATER_EXPECTED_ASSET || ""),
    attempts: Number(process.env.UPDATER_VERIFY_ATTEMPTS || "1"),
    delayMs: Number(process.env.UPDATER_VERIFY_DELAY_MS || "1000"),
    timeoutMs: Number(process.env.UPDATER_VERIFY_TIMEOUT_MS || "15000"),
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--kind") {
      options.kind = argv[index + 1] || "";
      index += 1;
      continue;
    }
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
    if (arg === "--asset") {
      options.assets.push(...parsePlatformList(argv[index + 1] || ""));
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
  if (options.kind !== "tauri-json" && options.kind !== "electron-yml") {
    throw new Error("--kind must be tauri-json or electron-yml.");
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

function unquoteYamlValue(value) {
  const trimmed = String(value ?? "").trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseElectronUpdaterYaml(body) {
  const manifest = { files: [] };
  let inFiles = false;
  let currentFile = null;

  for (const rawLine of String(body || "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;

    const topLevel = line.match(/^([A-Za-z][A-Za-z0-9_]*):(?:\s*(.*))?$/);
    if (topLevel) {
      const [, key, rawValue = ""] = topLevel;
      inFiles = key === "files";
      currentFile = null;
      if (!inFiles) {
        manifest[key] = unquoteYamlValue(rawValue);
      }
      continue;
    }

    if (!inFiles) continue;

    const fileStart = line.match(/^\s*-\s+([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (fileStart) {
      const [, key, rawValue] = fileStart;
      currentFile = {};
      currentFile[key] = unquoteYamlValue(rawValue);
      manifest.files.push(currentFile);
      continue;
    }

    const fileField = line.match(/^\s+([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (fileField && currentFile) {
      const [, key, rawValue] = fileField;
      currentFile[key] = unquoteYamlValue(rawValue);
    }
  }

  return manifest;
}

function validateElectronUpdaterManifest(manifest, { version = "", assets = [] } = {}) {
  const errors = [];
  const expectedVersion = String(version || "").trim().replace(/^v/, "");
  const expectedAssets = assets.map((asset) => String(asset).trim()).filter(Boolean);

  if (!isRecord(manifest)) {
    return ["manifest must be a YAML object"];
  }

  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    errors.push("version must be a non-empty string");
  } else if (expectedVersion && manifest.version.trim().replace(/^v/, "") !== expectedVersion) {
    errors.push(`version must be ${expectedVersion}`);
  }

  if (typeof manifest.releaseDate !== "string" || !manifest.releaseDate.trim()) {
    errors.push("releaseDate must be a non-empty string");
  } else if (Number.isNaN(Date.parse(manifest.releaseDate))) {
    errors.push("releaseDate must be a valid date string");
  }

  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    errors.push("files must contain at least one updater asset");
  } else {
    const urls = [];
    for (const [index, file] of manifest.files.entries()) {
      if (!isRecord(file)) {
        errors.push(`file ${index + 1} must be an object`);
        continue;
      }
      if (typeof file.url !== "string" || !file.url.trim()) {
        errors.push(`file ${index + 1} must include a non-empty url`);
      } else {
        urls.push(file.url.trim());
      }
      if (typeof file.sha512 !== "string" || !file.sha512.trim()) {
        errors.push(`file ${index + 1} must include a non-empty sha512`);
      }
      if (file.size !== undefined && (!Number.isInteger(Number(file.size)) || Number(file.size) <= 0)) {
        errors.push(`file ${index + 1} size must be a positive integer`);
      }
    }

    for (const asset of expectedAssets) {
      if (!urls.some((url) => url === asset || url.endsWith(`/${asset}`))) {
        errors.push(`files must include ${asset}`);
      }
    }

    if (typeof manifest.path !== "string" || !manifest.path.trim()) {
      errors.push("path must be a non-empty string");
    } else if (!urls.includes(manifest.path.trim())) {
      errors.push("path must point at one of the files");
    }
    if (typeof manifest.sha512 !== "string" || !manifest.sha512.trim()) {
      errors.push("sha512 must be a non-empty string");
    } else {
      const pathFile = manifest.files.find((file) => isRecord(file) && file.url === manifest.path);
      if (pathFile?.sha512 && pathFile.sha512 !== manifest.sha512) {
        errors.push("sha512 must match the selected path file");
      }
    }
  }

  return errors;
}

async function fetchUpdaterSource(url, { timeoutMs, accept = "application/json" } = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: accept,
      "User-Agent": "openwork-release-updater-verify",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs ?? 15000),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Updater endpoint returned HTTP ${response.status}: ${url}\n${body.slice(0, 400)}`);
  }

  return body;
}

async function fetchUpdaterManifest(url, { timeoutMs } = {}) {
  const body = await fetchUpdaterSource(url, { timeoutMs, accept: "application/json" });
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

async function readUpdaterSource(path) {
  return readFile(path, "utf8");
}

async function main() {
  const options = parseArgs(process.argv);
  let lastError = null;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      const manifest = options.file
        ? options.kind === "tauri-json"
          ? await readUpdaterManifest(options.file)
          : parseElectronUpdaterYaml(await readUpdaterSource(options.file))
        : options.kind === "tauri-json"
          ? await fetchUpdaterManifest(options.url, { timeoutMs: options.timeoutMs })
          : parseElectronUpdaterYaml(
              await fetchUpdaterSource(options.url, { timeoutMs: options.timeoutMs, accept: "application/yaml,text/yaml,text/plain" }),
            );
      const errors =
        options.kind === "tauri-json"
          ? validateUpdaterManifest(manifest, {
              platforms: options.platforms,
              version: options.version,
              assetTag: options.assetTag,
            })
          : validateElectronUpdaterManifest(manifest, {
              version: options.version,
              assets: options.assets,
            });

      if (errors.length) {
        throw new Error(`Invalid updater manifest:\n${errors.map((error) => `- ${error}`).join("\n")}`);
      }

      const platformCount =
        options.kind === "tauri-json" ? Object.keys(manifest.platforms).length : manifest.files.length;
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

export { parseArgs, parseElectronUpdaterYaml, validateElectronUpdaterManifest, validateUpdaterManifest };
