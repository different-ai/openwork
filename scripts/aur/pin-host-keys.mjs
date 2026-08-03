#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

export const AUR_HOST_FINGERPRINTS = {
  "ssh-ed25519": "SHA256:RFzBCUItH9LZS0cKB5UE6ceAYhBD5C8GeOBip8Z11+4",
  "ecdsa-sha2-nistp256": "SHA256:uTa/0PndEgPZTf76e1DFqXKJEXKsn7m9ivhLQtzGOCI",
  "ssh-rsa": "SHA256:5s5cIyReIfNNVGRFdDbe3hdYiI5OelHGpw2rOUud3Q8",
};

export function validateHostFingerprints(records) {
  const seen = new Set();
  for (const record of records) {
    const expected = AUR_HOST_FINGERPRINTS[record.type];
    if (!expected) throw new Error(`Unexpected AUR host key type: ${record.type}`);
    if (record.fingerprint !== expected) throw new Error(`AUR ${record.type} host fingerprint mismatch.`);
    if (seen.has(record.type)) throw new Error(`Duplicate AUR host key type: ${record.type}`);
    seen.add(record.type);
  }
  const missing = Object.keys(AUR_HOST_FINGERPRINTS).filter((type) => !seen.has(type));
  if (missing.length > 0) throw new Error(`Missing pinned AUR host key types: ${missing.join(", ")}`);
}

function fingerprint(line) {
  const result = spawnSync("ssh-keygen", ["-lf", "-", "-E", "sha256"], {
    input: `${line}\n`,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`Could not fingerprint AUR host key: ${result.stderr}`);
  const match = result.stdout.match(/\b(SHA256:[A-Za-z0-9+/]+)\b/);
  if (!match) throw new Error("ssh-keygen did not return a SHA-256 fingerprint.");
  return match[1];
}

function main() {
  const [scanPath, knownHostsPath] = process.argv.slice(2);
  if (!scanPath || !knownHostsPath) throw new Error("Usage: pin-host-keys.mjs <ssh-keyscan-output> <known-hosts>");
  const lines = readFileSync(scanPath, "utf8").split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"));
  const records = lines.map((line) => ({
    type: line.split(/\s+/)[1],
    fingerprint: fingerprint(line),
  }));
  validateHostFingerprints(records);
  appendFileSync(knownHostsPath, `${lines.join("\n")}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
