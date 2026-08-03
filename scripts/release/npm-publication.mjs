#!/usr/bin/env node
import { readFileSync } from "node:fs";

const VERSION = /^\d+\.\d+\.\d+$/;

export function decideNpmPublication({ version, status, stdout, stderr }) {
  if (!VERSION.test(version)) throw new Error(`Invalid npm release version: ${version}`);
  if (status === 0) {
    let published;
    try {
      published = JSON.parse(stdout);
    } catch {
      throw new Error("npm registry returned invalid JSON.");
    }
    if (published !== version) throw new Error(`npm registry returned ${published}, expected exact openwork-server@${version}.`);
    return "keep";
  }
  if (/\bE404\b|ERR_PNPM_FETCH_404|404[^\n]*Not Found|Not Found[^\n]*404|is not in this registry/i.test(stderr)) return "publish";
  throw new Error(`npm registry lookup failed without a confirmed 404: ${stderr.trim() || `exit ${status}`}`);
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const decision = decideNpmPublication({
      version: flag("--version"),
      status: Number(flag("--status")),
      stdout: readFileSync(flag("--stdout"), "utf8"),
      stderr: readFileSync(flag("--stderr"), "utf8"),
    });
    process.stdout.write(`${decision}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
