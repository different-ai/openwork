import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(__dirname, "..", "package.json");
const versionsJsonPath = resolve(__dirname, "..", "src-tauri", "sidecars", "versions.json");

const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const versions = JSON.parse(readFileSync(versionsJsonPath, "utf8"));

const expected = String(pkg.opencodeVersion ?? "").trim().replace(/^v/, "");
const actual = String(versions?.opencode?.version ?? "").trim().replace(/^v/, "");

if (!expected || !actual) {
  console.error("Missing OpenCode version in package.json or sidecars/versions.json");
  process.exit(1);
}

if (expected !== actual) {
  console.error(`OpenCode version mismatch: package.json=${expected}, versions.json=${actual}`);
  process.exit(1);
}

console.log(`OpenCode version sync OK: ${expected}`);
