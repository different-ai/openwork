import { basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const usage = "Usage: node .opencode/skills/upload-photo/scripts/upload.mjs <file.png> [more files...] [--prefix <path/prefix>] [--stable]";

function printUsage(message = null) {
  if (message) console.error(message);
  console.error(usage);
}

function parseArgs(argv) {
  const files = [];
  let prefix = `uploads/${new Date().toISOString().slice(0, 10)}`;
  let stable = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--stable") {
      stable = true;
      continue;
    }
    if (arg === "--prefix") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return null;
      prefix = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) return null;
    files.push(arg);
  }

  if (files.length === 0) return null;
  return { files, prefix, stable };
}

function contentTypeFor(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".avif")) return "image/avif";
  return "application/octet-stream";
}

function encodePathname(pathname) {
  return pathname.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function buildPathname(prefix, file) {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "");
  return encodePathname([cleanPrefix, basename(file)].filter(Boolean).join("/"));
}

async function uploadFile({ file, prefix, stable, token }) {
  if (!existsSync(file)) {
    console.error(`File does not exist: ${file}`);
    return 1;
  }

  const pathname = buildPathname(prefix, file);
  const headers = {
    authorization: `Bearer ${token}`,
    "x-content-type": contentTypeFor(file),
  };
  if (stable) headers["x-add-random-suffix"] = "0";

  const response = await fetch(`https://blob.vercel-storage.com/${pathname}`, {
    method: "PUT",
    headers,
    body: readFileSync(file),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    console.error(`Upload failed (${response.status}) for ${file}: ${detail}`);
    return 1;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    console.error(`Upload failed for ${file}: response was not JSON`);
    return 1;
  }

  if (!payload || typeof payload.url !== "string" || payload.url.length === 0) {
    console.error(`Upload failed for ${file}: response did not include url`);
    return 1;
  }

  console.log(payload.url);
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    printUsage();
    return 1;
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    console.error("BLOB_READ_WRITE_TOKEN is not set — fetch it with the get-env-var skill: export BLOB_READ_WRITE_TOKEN=\"$(infisical secrets get BLOB_READ_WRITE_TOKEN --plain --silent)\"");
    return 1;
  }

  for (const file of args.files) {
    const status = await uploadFile({ file, prefix: args.prefix, stable: args.stable, token });
    if (status !== 0) return status;
  }

  return 0;
}

process.exitCode = await main();
