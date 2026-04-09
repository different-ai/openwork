#!/usr/bin/env node
/**
 * i18n-audit.mjs — Find missing translations and improperly used translation keys.
 *
 * Usage:
 *   node scripts/i18n-audit.mjs              # full audit (default, excludes --hardcoded, --aliases, --prune, --sort)
 *   node scripts/i18n-audit.mjs --missing    # missing keys (in EN but not in locale)
 *   node scripts/i18n-audit.mjs --orphan     # orphan keys (in locale but not in EN)
 *   node scripts/i18n-audit.mjs --duplicates # duplicate keys in any locale
 *   node scripts/i18n-audit.mjs --unused     # unused keys (in EN but not referenced in repo)
 *   node scripts/i18n-audit.mjs --dangling   # t() calls referencing keys not in en.ts
 *   node scripts/i18n-audit.mjs --aliases    # aliased t() calls (translate/tr instead of t)
 *   node scripts/i18n-audit.mjs --placeholders # placeholder integrity check
 *   node scripts/i18n-audit.mjs --hardcoded  # hardcoded English strings in source files
 *   node scripts/i18n-audit.mjs --prune      # (destructive) remove unused keys from all locales
 *   node scripts/i18n-audit.mjs --sort       # (destructive) alphabetically sort keys in all locales
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

const mode = process.argv[2] ?? "--all";
const EXCLUDED_FROM_ALL = new Set(["--hardcoded", "--aliases"]);
const shouldRun = (...modes) => (mode === "--all" && !modes.some((m) => EXCLUDED_FROM_ALL.has(m))) || modes.includes(mode);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a locale .ts file into a JS object via eval. */
function parseLocale(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const match = content.match(/export default \{([\s\S]*?)\} as const;/);
  if (!match) throw new Error(`Could not parse ${filePath}`);
  return new Function(`return {${match[1]}}`)();
}

/** Extract translation keys from a locale .ts file (as a Set). */
function extractKeys(filePath) {
  return new Set(Object.keys(parseLocale(filePath)));
}

/** Extract key→value map from a locale .ts file. */
function extractKeyValues(filePath) {
  return new Map(Object.entries(parseLocale(filePath)));
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

/** Find duplicate keys in a file (must use regex — JSON.parse dedupes silently). */
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
if (shouldRun("--missing")) {
  console.log("=== Missing keys (in en.ts but not in locale) ===");
  for (const locale of LOCALES) {
    const file = join(LOCALES_DIR, `${locale}.ts`);
    if (!existsSync(file)) continue;
    const localeKeys = extractKeys(file);
    const missing = [...enKeys].filter((k) => !localeKeys.has(k));

    if (missing.length === 0) {
      console.log(`  ${locale}: ✓ no missing`);
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
if (shouldRun("--orphan")) {
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
if (shouldRun("--duplicates")) {
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
if (shouldRun("--unused", "--prune")) {
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

// --- 6. Dangling t() calls (referencing keys not in en.ts) ---
if (shouldRun("--dangling")) {
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

  // --- 7. Dynamic t() calls (keys built at runtime) ---
  console.log("=== Dynamic t() calls (keys built at runtime) ===");
  const dynamicPattern = /\b(?:t|translate|tr)\(\s*(`[^`]*\$\{|[^"'][^,)]*\+)/g;
  const dynamicHits = [];
  for (const file of sourceFiles) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (dynamicPattern.test(lines[i])) {
        dynamicHits.push({ file: file.replace(REPO_ROOT + "/", ""), line: i + 1, text: lines[i].trim() });
      }
      dynamicPattern.lastIndex = 0;
    }
  }

  if (dynamicHits.length === 0) {
    console.log("  ✓ no dynamic key construction");
  } else {
    console.log(`  ✗ ${dynamicHits.length} dynamic key constructions (should be static strings)`);
    exitCode = 1;
    for (const { file, line, text } of dynamicHits) {
      console.log(`    ${file}:${line}`);
      console.log(`      ${text.slice(0, 120)}`);
    }
  }
  console.log();
}

// --- 8. Aliased t() calls (should use t() directly, not translate/tr wrappers) ---
if (shouldRun("--aliases")) {
  console.log("=== Aliased t() calls (should use t() directly) ===");

  const aliasSourceFiles = collectSourceFiles(APP_SRC, (dir) => dir.includes("locales"));
  const aliasPattern = /\b(?:translate|tr)\s*\(/g;
  const aliasDefPattern = /(?:const|function)\s+(?:translate|tr)\s*[=(]/;
  const hits = [];

  for (const file of aliasSourceFiles) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      // Skip alias definitions themselves
      if (aliasDefPattern.test(lines[i])) continue;
      if (aliasPattern.test(lines[i])) {
        hits.push({ file: file.replace(REPO_ROOT + "/", ""), line: i + 1, text: lines[i].trim() });
      }
      aliasPattern.lastIndex = 0;
    }
  }

  if (hits.length === 0) {
    console.log("  ✓ all calls use t() directly");
  } else {
    console.log(`  ⚠ ${hits.length} aliased calls (translate/tr instead of t)`);
    for (const { file, line, text } of hits) {
      console.log(`    ${file}:${line}`);
      console.log(`      ${text.slice(0, 120)}`);
    }
  }
  console.log();
}

// --- 9. Placeholder integrity ---
if (shouldRun("--placeholders")) {
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

// --- 10. Hardcoded English scan ---
if (shouldRun("--hardcoded")) {
  console.log("=== Hardcoded English scan ===");

  const hardcodedFiles = collectSourceFiles(APP_SRC, (dir) => dir.includes("locales"));

  const excludePatterns = [
    /import\b/, /from\s+"/, /class=/, /\btype\s/, /\bconst\s/, /variant=/,
    /\bt\(/, /translate\(/, /"connected"/, /"allow"/, /"local"/, /"remote"/,
    /"object"/, /"string"/, /"user"/, /"assistant"/, /"Escape"/, /"Arrow/,
    /"Enter"/, /"prompt"/, /"session"/, /"automation"/, /"minimal"/, /"starter"/,
    /"docker"/, /"opencode"/, /"simple"/, /"Started"/, /"Progress"/,
    /^\s*\/\//, /^\s*\/\*/,
  ];

  const englishPattern = />[A-Z][a-z]{2,}[^<]*<|"[A-Z][a-z]{3,}[a-z ]+[.!?]?"/;

  for (const full of hardcodedFiles) {
    const name = full.replace(APP_SRC + "/", "");
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

// --- 11. Sort ---
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
console.log("Run with --missing, --orphan, --duplicates, --unused, --dangling, --placeholders, --hardcoded, --prune, or --sort for a single check.");
process.exit(exitCode);
