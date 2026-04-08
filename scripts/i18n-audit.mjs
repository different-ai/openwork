#!/usr/bin/env node
/**
 * i18n-audit.mjs — Find missing translations and improperly used translation keys.
 *
 * Usage:
 *   node scripts/i18n-audit.mjs              # full audit
 *   node scripts/i18n-audit.mjs --missing    # only missing keys
 *   node scripts/i18n-audit.mjs --orphan     # only orphan keys (in locale but not in EN)
 *   node scripts/i18n-audit.mjs --unused     # only unused keys (in EN but never referenced in source)
 *   node scripts/i18n-audit.mjs --hardcoded  # only hardcoded English strings in source files
 *   node scripts/i18n-audit.mjs --summary    # counts only, no key lists
 *   node scripts/i18n-audit.mjs --dangling   # find t() calls referencing keys not in en.ts
 *   node scripts/i18n-audit.mjs --prune      # remove unused keys from all locales
 *   node scripts/i18n-audit.mjs --sort       # alphabetically sort keys in all locales
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const LOCALES_DIR = join(REPO_ROOT, "apps/app/src/i18n/locales");
const APP_SRC = join(REPO_ROOT, "apps/app/src");

const LOCALES = ["ja", "zh", "vi", "pt-BR", "th"];
const EN_FILE = join(LOCALES_DIR, "en.ts");

const mode = process.argv[2] ?? "all";
const shouldRun = (...modes) => mode === "all" || modes.includes(mode);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract translation keys from a locale .ts file. */
function extractKeys(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const keys = new Set();
  for (const match of content.matchAll(/^\s*"([^"]+)"\s*:/gm)) {
    keys.add(match[1]);
  }
  return keys;
}

/** Extract key→value map from a locale .ts file. */
function extractKeyValues(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const map = new Map();
  // Match single-line: "key": "value",  and  "key": "value"
  // Also match multi-line: "key":\n    "value",
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const singleLine = lines[i].match(/^\s*"([^"]+)"\s*:\s*"(.*)"/);
    if (singleLine) {
      map.set(singleLine[1], singleLine[2]);
      continue;
    }
    const keyOnly = lines[i].match(/^\s*"([^"]+)"\s*:\s*$/);
    if (keyOnly && i + 1 < lines.length) {
      const valLine = lines[i + 1].match(/^\s*"(.*)"/);
      if (valLine) {
        map.set(keyOnly[1], valLine[1]);
      }
    }
  }
  return map;
}

/** Find all {placeholders} in a string. */
function findPlaceholders(str) {
  return [...str.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[0]).sort();
}

/** Recursively collect all .ts/.tsx files under a directory. */
function collectSourceFiles(dir, exclude) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (exclude && exclude(full)) continue;
      results.push(...collectSourceFiles(full, exclude));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

/** Group an array of strings by prefix (before first dot). */
function groupByPrefix(keys) {
  const groups = new Map();
  for (const key of keys) {
    const prefix = key.split(".")[0];
    groups.set(prefix, (groups.get(prefix) ?? 0) + 1);
  }
  return [...groups.entries()].sort((a, b) => b[1] - a[1]);
}

/** Find duplicate keys in a file. */
function findDuplicates(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const seen = new Map();
  const dupes = [];
  for (const match of content.matchAll(/^\s*"([^"]+)"\s*:/gm)) {
    const key = match[1];
    if (seen.has(key)) dupes.push(key);
    else seen.set(key, true);
  }
  return dupes;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const enKeys = extractKeys(EN_FILE);
const enKeyValues = extractKeyValues(EN_FILE);
let exitCode = 0;

console.log("╔══════════════════════════════════════════════════╗");
console.log("║              i18n Audit Report                   ║");
console.log("╚══════════════════════════════════════════════════╝");
console.log();

// --- 1. Key counts ---
console.log("=== Key counts ===");
console.log(`  en       ${enKeys.size} keys (source of truth)`);
for (const locale of LOCALES) {
  const file = join(LOCALES_DIR, `${locale}.ts`);
  if (!existsSync(file)) {
    console.log(`  ${locale.padEnd(8)} MISSING FILE`);
    continue;
  }
  const keys = extractKeys(file);
  const pct = Math.round((keys.size / enKeys.size) * 100);
  console.log(`  ${locale.padEnd(8)} ${keys.size} keys (${pct}%)`);
}
console.log();

// --- 2. Missing keys ---
if (shouldRun("--missing", "--summary")) {
  console.log("=== Missing keys (in en.ts but not in locale) ===");
  for (const locale of LOCALES) {
    const file = join(LOCALES_DIR, `${locale}.ts`);
    if (!existsSync(file)) continue;
    const localeKeys = extractKeys(file);
    const missing = [...enKeys].filter((k) => !localeKeys.has(k));

    if (missing.length === 0) {
      console.log(`  ${locale}: ✓ complete`);
    } else {
      console.log(`  ${locale}: ✗ ${missing.length} missing`);
      exitCode = 1;
      if (mode !== "--summary") {
        for (const [prefix, count] of groupByPrefix(missing).slice(0, 15)) {
          console.log(`    ${String(count).padStart(4)}  ${prefix}.*`);
        }
        const totalGroups = new Set(missing.map((k) => k.split(".")[0])).size;
        if (totalGroups > 15) console.log(`    ... and ${totalGroups - 15} more groups`);
      }
    }
  }
  console.log();
}

// --- 3. Orphan keys ---
if (shouldRun("--orphan", "--summary")) {
  console.log("=== Orphan keys (in locale but not in en.ts) ===");
  for (const locale of LOCALES) {
    const file = join(LOCALES_DIR, `${locale}.ts`);
    if (!existsSync(file)) continue;
    const localeKeys = extractKeys(file);
    const orphans = [...localeKeys].filter((k) => !enKeys.has(k));

    if (orphans.length === 0) {
      console.log(`  ${locale}: ✓ no orphans`);
    } else {
      console.log(`  ${locale}: ⚠ ${orphans.length} orphan keys`);
      if (mode !== "--summary") {
        for (const key of orphans.slice(0, 10)) console.log(`    ${key}`);
        if (orphans.length > 10) console.log(`    ... and ${orphans.length - 10} more`);
      }
    }
  }
  console.log();
}

// --- 4. Duplicate keys ---
if (shouldRun("--summary")) {
  console.log("=== Duplicate keys ===");
  for (const locale of ["en", ...LOCALES]) {
    const file = join(LOCALES_DIR, `${locale}.ts`);
    if (!existsSync(file)) continue;
    const dupes = findDuplicates(file);
    if (dupes.length === 0) {
      console.log(`  ${locale}: ✓ no duplicates`);
    } else {
      console.log(`  ${locale}: ✗ ${dupes.length} duplicate keys`);
      exitCode = 1;
      if (mode !== "--summary") {
        for (const key of dupes.slice(0, 5)) console.log(`    ${key}`);
      }
    }
  }
  console.log();
}

// --- 5. Unused keys ---
if (shouldRun("--unused", "--summary", "--prune")) {
  console.log("=== Unused keys (in en.ts but never referenced in repo) ===");

  // Search the ENTIRE repo (not just apps/app/src) for key references
  const repoSourceFiles = collectSourceFiles(REPO_ROOT, (dir) =>
    ["node_modules", ".git", "target", "dist", ".next", "locales"].some((x) => dir.includes(x)),
  );
  const allSource = repoSourceFiles.map((f) => readFileSync(f, "utf-8")).join("\n");

  const unused = [...enKeys].filter((key) => !allSource.includes(key));

  if (unused.length === 0) {
    console.log("  ✓ all keys referenced in source");
  } else {
    console.log(`  ⚠ ${unused.length} potentially unused keys`);
    if (mode !== "--summary") {
      for (const [prefix, count] of groupByPrefix(unused).slice(0, 15)) {
        console.log(`    ${String(count).padStart(4)}  ${prefix}.*`);
      }
      if (mode === "--unused") {
        console.log();
        for (const key of unused) console.log(`    ${key}`);
      }
    }
  }

  // --- Prune mode ---
  if (mode === "--prune" && unused.length > 0) {
    console.log();
    console.log(`  Pruning ${unused.length} unused keys from all locale files...`);
    const unusedSet = new Set(unused);
    const allLocaleFiles = ["en", ...LOCALES].map((l) => join(LOCALES_DIR, `${l}.ts`));

    for (const file of allLocaleFiles) {
      if (!existsSync(file)) continue;
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");
      const filtered = [];
      let skipNextLine = false;

      for (let i = 0; i < lines.length; i++) {
        if (skipNextLine) {
          skipNextLine = false;
          continue;
        }
        const keyMatch = lines[i].match(/^\s*"([^"]+)"\s*:/);
        if (keyMatch && unusedSet.has(keyMatch[1])) {
          // Check if value is on the next line (multi-line entry)
          if (!lines[i].includes('",') && !lines[i].includes('": "') && i + 1 < lines.length) {
            skipNextLine = true;
          }
          continue; // skip this line
        }
        filtered.push(lines[i]);
      }

      writeFileSync(file, filtered.join("\n"));
      const locale = basename(file, ".ts");
      const removed = lines.length - filtered.length;
      console.log(`    ${locale}: removed ${removed} lines`);
    }
  }
  console.log();
}

// --- 6. Placeholder integrity ---
if (shouldRun("--summary")) {
  console.log("=== Placeholder integrity ===");
  let problems = 0;

  for (const [key, enValue] of enKeyValues) {
    const enPh = findPlaceholders(enValue);
    if (enPh.length === 0) continue;

    for (const locale of LOCALES) {
      const file = join(LOCALES_DIR, `${locale}.ts`);
      if (!existsSync(file)) continue;
      const localeKV = extractKeyValues(file);
      const localeValue = localeKV.get(key);
      if (!localeValue) continue;

      const localePh = findPlaceholders(localeValue);
      for (const ph of enPh) {
        if (!localePh.includes(ph)) {
          console.log(`  ✗ ${locale}/${key}: missing placeholder ${ph}`);
          problems++;
          exitCode = 1;
        }
      }
    }
  }

  if (problems === 0) console.log("  ✓ all placeholders preserved");
  else console.log(`  ✗ ${problems} placeholder issues`);
  console.log();
}

// --- 7. Dangling t() calls (referencing keys not in en.ts) ---
if (shouldRun("--dangling", "--summary")) {
  console.log("=== Dangling t() calls (keys not in en.ts) ===");

  const sourceFiles = collectSourceFiles(APP_SRC, (dir) => dir.includes("locales"));
  // Match t("key.name"), t("key.name", ...), translate("key.name"), tr("key.name")
  const keyRefPattern = /\b(?:t|translate|tr)\(\s*"([a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*?)"/g;

  const dangling = [];
  for (const file of sourceFiles) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const match of lines[i].matchAll(keyRefPattern)) {
        const key = match[1];
        if (!enKeys.has(key)) {
          dangling.push({ key, file: file.replace(REPO_ROOT + "/", ""), line: i + 1 });
        }
      }
    }
  }

  if (dangling.length === 0) {
    console.log("  ✓ all t() keys exist in en.ts");
  } else {
    console.log(`  ✗ ${dangling.length} dangling references`);
    exitCode = 1;
    if (mode !== "--summary") {
      for (const { key, file, line } of dangling) {
        console.log(`    ${file}:${line} → "${key}"`);
      }
    }
  }
  console.log();
}

// --- 8. Hardcoded English scan ---
if (shouldRun("--hardcoded")) {
  console.log("=== Hardcoded English scan (key source files) ===");

  const hardcodedFiles = [
    "apps/app/src/app/app-settings/authorized-folders-panel.tsx",
    "apps/app/src/app/components/model-picker-modal.tsx",
    "apps/app/src/app/lib/workspace-blueprints.ts",
    "apps/app/src/app/lib/model-behavior.ts",
    "apps/app/src/app/lib/session-title.ts",
    "apps/app/src/app/constants.ts",
    "apps/app/src/app/system-state.ts",
    "apps/app/src/app/pages/settings.tsx",
  ];

  const excludePatterns = [
    /import\b/, /from\s+"/, /class=/, /\btype\s/, /\bconst\s/, /variant=/,
    /\bt\(/, /translate\(/, /"connected"/, /"allow"/, /"local"/, /"remote"/,
    /"object"/, /"string"/, /"user"/, /"assistant"/, /"Escape"/, /"Arrow/,
    /"Enter"/, /"prompt"/, /"session"/, /"automation"/, /"minimal"/, /"starter"/,
    /"docker"/, /"opencode"/, /"simple"/,
  ];

  const englishPattern = />[A-Z][a-z]{2,}[^<]*<|"[A-Z][a-z]{3,}[a-z ]+[.!?]?"/;

  for (const rel of hardcodedFiles) {
    const full = join(REPO_ROOT, rel);
    if (!existsSync(full)) continue;
    const name = basename(rel);
    const lines = readFileSync(full, "utf-8").split("\n");
    const hits = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!englishPattern.test(line)) continue;
      if (excludePatterns.some((p) => p.test(line))) continue;
      hits.push(`    ${i + 1}: ${line.trim()}`);
      if (hits.length >= 5) break;
    }

    if (hits.length === 0) {
      console.log(`  ${name}: ✓ clean`);
    } else {
      console.log(`  ${name}: ⚠ possible hardcoded strings:`);
      for (const hit of hits) console.log(hit);
    }
  }
  console.log();
}

// --- 8. Sort ---
if (mode === "--sort") {
  console.log("=== Sorting all locale files alphabetically ===");
  const allLocaleFiles = ["en", ...LOCALES].map((l) => join(LOCALES_DIR, `${l}.ts`));

  const PLURAL_ORDER = { _zero: 0, _one: 1, _two: 2, _few: 3, _many: 4, _other: 5 };

  function sortKey(key) {
    let normalized = key.replace(/\./g, "\x00");
    for (const [suffix, order] of Object.entries(PLURAL_ORDER)) {
      if (normalized.endsWith(suffix)) {
        normalized = normalized.slice(0, -suffix.length) + `\x01${order}`;
        break;
      }
    }
    return normalized;
  }

  for (const file of allLocaleFiles) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf-8");

    // Extract preamble (header comment) and body
    const exportMatch = content.match(/^([\s\S]*?)(export default \{)([\s\S]*?)(\} as const;\s*)$/);
    if (!exportMatch) {
      console.log(`  ${basename(file, ".ts")}: ⚠ could not parse, skipped`);
      continue;
    }
    const [, preamble, , body] = exportMatch;

    // Eval the body as a JS object to get all key-value pairs
    let obj;
    try {
      obj = new Function(`return {${body}}`)();
    } catch (e) {
      console.log(`  ${basename(file, ".ts")}: ⚠ eval failed, skipped (${e.message})`);
      continue;
    }

    // Sort keys
    const sortedKeys = Object.keys(obj).sort((a, b) => {
      const ak = sortKey(a);
      const bk = sortKey(b);
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });

    // Rebuild — JSON.stringify handles all escaping (\n, quotes, etc.)
    const lines = sortedKeys.map((key) =>
      `  ${JSON.stringify(key)}: ${JSON.stringify(obj[key])},`
    );
    writeFileSync(file, `${preamble}export default {\n${lines.join("\n")}\n} as const;\n`);
    const locale = basename(file, ".ts");
    console.log(`  ${locale}: ${sortedKeys.length} keys sorted`);
  }
  console.log();
}

// --- Done ---
console.log("=== Done ===");
console.log("Run with --missing, --orphan, --unused, --dangling, --hardcoded, --prune, --sort, or --summary for focused output.");
process.exit(exitCode);
