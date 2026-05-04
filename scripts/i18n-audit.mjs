#!/usr/bin/env node
/**
 * i18n-audit.mjs — Find missing translations and improperly used translation keys.
 *
 * Usage:
 *   node scripts/i18n-audit.mjs              # full audit (default, excludes --hardcoded, --prune, --sort)
 *   node scripts/i18n-audit.mjs --ci         # same as default but does not fail on missing non-en keys
 *   node scripts/i18n-audit.mjs --missing    # missing keys (in EN but not in locale)
 *   node scripts/i18n-audit.mjs --orphan     # orphan keys (in locale but not in EN)
 *   node scripts/i18n-audit.mjs --duplicates # duplicate keys in any locale
 *   node scripts/i18n-audit.mjs --unused     # unused keys (in EN but not referenced in repo)
 *   node scripts/i18n-audit.mjs --dangling   # t() calls referencing keys not in en.ts
 *   node scripts/i18n-audit.mjs --aliases    # aliased t() calls (translate/tr instead of t)
 *   node scripts/i18n-audit.mjs --placeholders # placeholder integrity check
 *   node scripts/i18n-audit.mjs --plurals    # each locale has bare key OR all CLDR plural forms it needs
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

const LOCALES = ["ja", "zh", "vi", "pt-BR", "th", "fr", "ca", "es", "ru"];
const EN_FILE = join(LOCALES_DIR, "en.ts");

const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"];
const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/;
const stripPluralSuffix = (key) => key.replace(PLURAL_SUFFIX_RE, "");

// Directory names skipped during the source scan. The "locales" dir is intentionally
// skipped; otherwise translation keys will trivially match themselves.
const SKIP_DIRS = ["locales", "node_modules", "target", "dist", "build", "out", "coverage"];

const mode = process.argv[2] ?? "--all";
const isCi = mode === "--ci";
const isAll = mode === "--all" || isCi;
const EXCLUDED_FROM_ALL = new Set(["--hardcoded"]);
const shouldRun = (...modes) => (isAll && !modes.some((m) => EXCLUDED_FROM_ALL.has(m))) || modes.includes(mode);

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
      if (!isCi) exitCode = 1;
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

// Locales without plurals (e.g. Chinese, Japanese) use the bare key while en
// defines suffixed variants — that's not orphan. The reverse (locale has a
// suffix en doesn't) is also fine: the runtime falls back to en's bare or
// other-suffix key.
const enHasAnyPluralVariant = (key) =>
  PLURAL_SUFFIXES.some((suffix) => enKeys.has(`${key}_${suffix}`));
const isOrphan = (key) => {
  if (enKeys.has(key)) return false;
  if (enHasAnyPluralVariant(key)) return false;
  const base = stripPluralSuffix(key);
  if (base !== key) {
    if (enKeys.has(base)) return false;
    if (enHasAnyPluralVariant(base)) return false;
  }
  return true;
};

// --- 3. Orphan keys ---
const orphansByLocale = {};
if (shouldRun("--orphan", "--prune")) {
  console.log("=== Orphan keys (in locale but not in en.ts) ===");
  for (const locale of LOCALES) {
    const file = join(LOCALES_DIR, `${locale}.ts`);
    if (!existsSync(file)) continue;
    const localeKeys = extractKeys(file);
    const orphans = [...localeKeys].filter(isOrphan);
    orphansByLocale[locale] = orphans;

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
let unusedKeys = [];
if (shouldRun("--unused", "--prune")) {
  console.log("=== Unused keys (in en.ts but never referenced in repo) ===");

  // Search the entire repo (not just apps/app/src) for key references.
  const repoSourceFiles = collectSourceFiles(REPO_ROOT, (dir) => {
    const name = basename(dir);
    return name.startsWith(".") || SKIP_DIRS.includes(name);
  });
  const allSource = repoSourceFiles.map((f) => readFileSync(f, "utf-8")).join("\n");

  // A plural-suffixed key (foo_one / foo_other) counts as "used" when the
  // base key (foo) is referenced — `t(key, { count })` resolves the suffix at
  // runtime so the source never names the suffixed variant directly.
  unusedKeys = [...enKeys].filter((key) => {
    if (allSource.includes(key)) return false;
    const base = stripPluralSuffix(key);
    if (base !== key && allSource.includes(base)) return false;
    return true;
  });

  if (unusedKeys.length === 0) {
    console.log("  ✓ all keys referenced in source");
  } else {
    console.log(`  ⚠ ${unusedKeys.length} potentially unused keys`);
    if (mode !== "--summary") {
      for (const [prefix, count] of groupByPrefix(unusedKeys).slice(0, 15)) {
        console.log(`    ${String(count).padStart(4)}  ${prefix}.*`);
      }
      console.log();
      for (const key of unusedKeys) console.log(`    ${key}`);
    }
    if (mode !== "--prune") {
      console.log();
      console.log("  (auto-fix with --prune option)");
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

  // A `t("foo")` call resolves if `foo` exists OR any plural variant
  // (`foo_one`, `foo_other`, etc.) exists — the runtime picks a variant
  // based on params.count.
  const keyResolves = (key) => {
    if (enKeys.has(key)) return true;
    return PLURAL_SUFFIXES.some((suffix) => enKeys.has(`${key}_${suffix}`));
  };

  const dangling = [];
  for (const file of sourceFiles) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const match of lines[i].matchAll(keyRefPattern)) {
        const key = match[1];
        if (!keyResolves(key)) {
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
  const aliasSkipPattern = /translate\s*\(\s*[-\d]|translate\s*\(\s*0|props\.translate|:\s*\(key:\s*string\)|`translate\(/;
  const hits = [];

  for (const file of aliasSourceFiles) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (aliasDefPattern.test(lines[i])) continue;
      if (aliasSkipPattern.test(lines[i])) continue;
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
      // {count} is optional in `_zero` / `_one` variants — the translator
      // can write "No messages" or "1 message" instead of "{count} message".
      const countOptional = /_(zero|one)$/.test(key);
      for (const ph of enPh) {
        if (countOptional && ph === "{count}") continue;
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

// --- 10. Plural completeness ---
// For every key whose en value contains `{count}`, each locale must define
// either the bare key (catch-all) or every plural form its language needs.
// Most languages use `_one`+`_other`; `PLURAL_FORMS` lists the languages
// that need more, verified against `Intl.PluralRules` (what `t()` uses at
// runtime based on CLDR).
const DEFAULT_PLURAL_FORM = ["one", "other"];
const PLURAL_FORMS = {
  ar: ["zero", "one", "two", "few", "many", "other"], // Arabic
  be: ["one", "few", "many", "other"],                // Belarusian
  bs: ["one", "few", "other"],                        // Bosnian
  cs: ["one", "few", "many", "other"],                // Czech
  cy: ["zero", "one", "two", "few", "many", "other"], // Welsh
  ga: ["one", "two", "few", "many", "other"],         // Irish
  gd: ["one", "two", "few", "other"],                 // Scottish Gaelic
  gv: ["one", "two", "few", "many", "other"],         // Manx
  he: ["one", "two", "other"],                        // Hebrew
  hr: ["one", "few", "other"],                        // Croatian
  iu: ["one", "two", "other"],                        // Inuktitut
  kw: ["zero", "one", "two", "few", "many", "other"], // Cornish
  lt: ["one", "few", "many", "other"],                // Lithuanian
  lv: ["zero", "one", "other"],                       // Latvian
  mt: ["one", "two", "few", "many", "other"],         // Maltese
  pl: ["one", "few", "many", "other"],                // Polish
  ro: ["one", "few", "other"],                        // Romanian
  ru: ["one", "few", "many", "other"],                // Russian
  sk: ["one", "few", "many", "other"],                // Slovak
  sl: ["one", "two", "few", "other"],                 // Slovenian
  sr: ["one", "few", "other"],                        // Serbian
  uk: ["one", "few", "many", "other"],                // Ukrainian
};

if (shouldRun("--plurals")) {
  console.log("=== Plural completeness ===");

  const pluralBases = new Set();
  for (const [key, value] of enKeyValues) {
    if (typeof value === "string" && value.includes("{count}")) {
      pluralBases.add(stripPluralSuffix(key));
    }
  }

  for (const locale of ["en", ...LOCALES]) {
    const file = join(LOCALES_DIR, `${locale}.ts`);
    if (!existsSync(file)) continue;
    const required = PLURAL_FORMS[locale] ?? DEFAULT_PLURAL_FORM;
    const localeKeys = extractKeys(file);
    const incomplete = [];

    for (const base of pluralBases) {
      if (localeKeys.has(base)) continue;
      const missing = required.filter((cat) => !localeKeys.has(`${base}_${cat}`));
      if (missing.length === required.length) continue; // locale has none of these — handled by --missing
      if (missing.length > 0) incomplete.push({ base, missing });
    }

    if (incomplete.length === 0) {
      console.log(`  ${locale}: ✓ all plural keys complete`);
    } else {
      console.log(`  ${locale}: ✗ ${incomplete.length} incomplete plural keys`);
      exitCode = 1;
      if (mode !== "--summary") {
        for (const { base, missing } of incomplete) {
          console.log(`    ${base}: missing ${missing.map((m) => `_${m}`).join(", ")}`);
        }
      }
    }
  }
  if (pluralBases.size === 0) {
    console.log("  (no plural-base keys found in en.ts)");
  }
  console.log();
}

// --- 11. Hardcoded English scan ---
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

// --- 12. Prune (destructive) ---
// Runs last so the user sees the unused/orphan reports above before
// keys are actually removed. Removes both unused-from-source keys (en
// only) and per-locale orphans (keys missing from en).
if (mode === "--prune") {
  console.log("=== Pruning ===");
  const unusedSet = new Set(unusedKeys);
  const allLocaleFiles = ["en", ...LOCALES].map((l) => join(LOCALES_DIR, `${l}.ts`));
  let totalRemoved = 0;

  for (const file of allLocaleFiles) {
    if (!existsSync(file)) continue;
    const localeName = basename(file, ".ts");
    const removeSet = new Set(unusedSet);
    const orphans = orphansByLocale[localeName] ?? [];
    for (const key of orphans) removeSet.add(key);
    const orphanCount = orphans.length;
    if (removeSet.size === 0) continue;

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
      if (keyMatch && removeSet.has(keyMatch[1])) {
        // Multi-line entry: value on next line
        if (!lines[i].includes('",') && !lines[i].includes('": "') && i + 1 < lines.length) {
          skipNextLine = true;
        }
        continue;
      }
      filtered.push(lines[i]);
    }

    writeFileSync(file, filtered.join("\n"));
    const removed = lines.length - filtered.length;
    totalRemoved += removed;
    const breakdown = orphanCount > 0
      ? ` (${removed - orphanCount} unused, ${orphanCount} orphan)`
      : "";
    console.log(`  ${localeName}: removed ${removed} lines${breakdown}`);
  }

  if (totalRemoved === 0) console.log("  ✓ nothing to prune");
  console.log();
}

// --- Done ---
console.log("=== Done ===");
process.exit(exitCode);
