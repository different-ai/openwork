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
 *   node scripts/i18n-audit.mjs --source-first # verify td() inline EN defaults match en.ts
 *   node scripts/i18n-audit.mjs --extract-source-first # update en.ts from td() defaults
 *   node scripts/i18n-audit.mjs --aliases    # aliased t() calls (translate/tr instead of t)
 *   node scripts/i18n-audit.mjs --placeholders # placeholder integrity check
 *   node scripts/i18n-audit.mjs --hardcoded  # hardcoded English strings in source files
 *   node scripts/i18n-audit.mjs --find "New Automation" # locate EN text -> key -> source refs
 *   node scripts/i18n-audit.mjs --prune      # (destructive) remove unused keys from all locales
 *   node scripts/i18n-audit.mjs --sort       # (destructive) alphabetically sort keys in all locales
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const LOCALES_DIR = join(REPO_ROOT, "apps/app/src/i18n/locales");
const APP_SRC = join(REPO_ROOT, "apps/app/src");
const tsModule = await import(pathToFileURL(join(REPO_ROOT, "apps/app/node_modules/typescript/lib/typescript.js")).href);
const ts = tsModule.default ?? tsModule;

const LOCALES = ["ja", "zh", "vi", "pt-BR", "th"];
const EN_FILE = join(LOCALES_DIR, "en.ts");

const args = process.argv.slice(2);
const mode = args[0] ?? "--all";
const queryArgs = mode === "--find" ? args.slice(1).filter((arg) => arg !== "--") : args.slice(1);
const query = queryArgs.join(" ").trim();
const EXCLUDED_FROM_ALL = new Set(["--hardcoded", "--aliases", "--find", "--extract-source-first"]);
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

function getLineNumber(content, matchIndex) {
  return content.slice(0, matchIndex).split("\n").length;
}

function parseDoubleQuotedLiteral(literal) {
  return JSON.parse(literal);
}

function extractSourceFirstDefaults(sourceFiles) {
  const defaults = new Map();
  const conflicts = [];
  const sourceFirstPattern = /\btd\(\s*"([a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*?)"\s*,\s*("(?:\\.|[^"\\])*")/g;

  for (const file of sourceFiles) {
    const content = readFileSync(file, "utf-8");
    for (const match of content.matchAll(sourceFirstPattern)) {
      const key = match[1];
      const literal = match[2];
      const line = getLineNumber(content, match.index ?? 0);
      const value = parseDoubleQuotedLiteral(literal);
      const reference = { file: toRelativePath(file), line, value };
      const existing = defaults.get(key);

      if (!existing) {
        defaults.set(key, { value, refs: [reference] });
        continue;
      }

      if (existing.value !== value) {
        conflicts.push({
          key,
          expected: existing.value,
          actual: value,
          original: existing.refs[0],
          conflicting: reference,
        });
        continue;
      }

      existing.refs.push(reference);
    }
  }

  return { defaults, conflicts };
}

function readLocaleFile(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const exportMatch = content.match(/^([\s\S]*?)(export default \{)([\s\S]*?)(\} as const;\s*)$/);
  if (!exportMatch) {
    throw new Error(`Could not parse ${filePath}`);
  }

  const [, preamble, , body] = exportMatch;
  const values = new Function(`return {${body}}`)();
  return { preamble, values };
}

function writeLocaleFile(filePath, preamble, values) {
  const lines = Object.keys(values)
    .map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(values[key])},`);
  writeFileSync(filePath, `${preamble}export default {\n${lines.join("\n")}\n} as const;\n`);
}

function scriptKind(filePath) {
  return filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function literalKey(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function findAliasNames(sourceFile) {
  const aliases = new Set();

  function visit(node) {
    let fn = null;
    let name = null;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      fn = node.initializer;
      name = node.name.text;
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      fn = node;
      name = node.name.text;
    }

    if (fn && name && ["translate", "tr"].includes(name) && fn.parameters[0] && ts.isIdentifier(fn.parameters[0].name) && fn.parameters[0].name.text === "key") {
      aliases.add(name);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return aliases;
}

function collectSourceFirstCoverageIssues(sourceFiles, keyValues) {
  const keyFirstCalls = [];
  const aliasMissingDefaults = [];

  for (const file of sourceFiles) {
    const content = readFileSync(file, "utf-8");
    const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKind(file));
    const aliases = findAliasNames(sourceFile);

    function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const key = literalKey(node.arguments[0]);
        if (key) {
          const fileRef = toRelativePath(file);
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

          if (node.expression.text === "t") {
            keyFirstCalls.push({ file: fileRef, line, key, text: node.getText(sourceFile) });
            return;
          }

          if (aliases.has(node.expression.text)) {
            const defaultValue = literalKey(node.arguments[1]);
            if (defaultValue !== keyValues.get(key)) {
              aliasMissingDefaults.push({ file: fileRef, line, key, text: node.getText(sourceFile) });
              return;
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return { keyFirstCalls, aliasMissingDefaults };
}

function toRelativePath(filePath) {
  return filePath.replace(REPO_ROOT + "/", "");
}

function normalizeSearchText(value) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function getSearchScore(value, normalizedQuery) {
  const normalizedValue = normalizeSearchText(value);
  if (normalizedValue === normalizedQuery) return 0;
  if (normalizedValue.startsWith(normalizedQuery)) return 1;
  if (normalizedValue.includes(normalizedQuery)) return 2;
  return Number.POSITIVE_INFINITY;
}

function findDirectSourceMatches(normalizedQuery, sourceFiles) {
  const matches = [];

  for (const file of sourceFiles) {
    const lines = readFileSync(file, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].trim();
      if (!text) continue;
      const score = getSearchScore(text, normalizedQuery);
      if (!Number.isFinite(score)) continue;
      matches.push({ file: toRelativePath(file), line: i + 1, text, score });
    }
  }

  return matches.sort((a, b) => a.score - b.score || a.file.localeCompare(b.file) || a.line - b.line);
}

function findStaticKeyReferences(key, sourceFiles) {
  const matches = [];

  for (const file of sourceFiles) {
    const lines = readFileSync(file, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(key)) continue;
      matches.push({ file: toRelativePath(file), line: i + 1, text: lines[i].trim() });
    }
  }

  return matches;
}

function findTranslationMatches(normalizedQuery, sourceFiles, keyValues) {
  const matches = [];

  for (const [key, value] of keyValues) {
    const score = Math.min(getSearchScore(key, normalizedQuery), getSearchScore(value, normalizedQuery));
    if (!Number.isFinite(score)) continue;
    matches.push({ key, value, score, references: findStaticKeyReferences(key, sourceFiles) });
  }

  return matches.sort((a, b) => a.score - b.score || a.key.localeCompare(b.key));
}

function runFindMode(rawQuery, keyValues) {
  if (!rawQuery) {
    console.error('Usage: node scripts/i18n-audit.mjs --find "English text"');
    process.exit(1);
  }

  const sourceFiles = collectSourceFiles(APP_SRC, (dir) => dir.includes("locales"));
  const normalizedQuery = normalizeSearchText(rawQuery);
  const directMatches = findDirectSourceMatches(normalizedQuery, sourceFiles);
  const translationMatches = findTranslationMatches(normalizedQuery, sourceFiles, keyValues);
  const DIRECT_MATCH_LIMIT = 20;
  const TRANSLATION_MATCH_LIMIT = 20;
  const REFERENCE_LIMIT = 10;

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║            i18n Text Locator                    ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log();
  console.log(`Query: ${JSON.stringify(rawQuery)}`);
  console.log();

  if (directMatches.length === 0 && translationMatches.length === 0) {
    console.log("No direct or translation matches found.");
    process.exit(1);
  }

  if (directMatches.length > 0) {
    console.log("=== Direct source matches ===");
    for (const { file, line, text } of directMatches.slice(0, DIRECT_MATCH_LIMIT)) {
      console.log(`  ${file}:${line}`);
      console.log(`    ${text.slice(0, 140)}`);
    }
    if (directMatches.length > DIRECT_MATCH_LIMIT) {
      console.log(`  ... and ${directMatches.length - DIRECT_MATCH_LIMIT} more direct matches`);
    }
    console.log();
  }

  if (translationMatches.length > 0) {
    console.log("=== Translation matches ===");
    for (const { key, value, references } of translationMatches.slice(0, TRANSLATION_MATCH_LIMIT)) {
      console.log(`  ${key}`);
      console.log(`    English: ${value}`);
      if (references.length === 0) {
        console.log("    References: no static references found in app source");
      } else {
        console.log("    References:");
        for (const { file, line, text } of references.slice(0, REFERENCE_LIMIT)) {
          console.log(`      ${file}:${line}`);
          console.log(`        ${text.slice(0, 120)}`);
        }
        if (references.length > REFERENCE_LIMIT) {
          console.log(`      ... and ${references.length - REFERENCE_LIMIT} more references`);
        }
      }
    }
    if (translationMatches.length > TRANSLATION_MATCH_LIMIT) {
      console.log(`  ... and ${translationMatches.length - TRANSLATION_MATCH_LIMIT} more translation matches`);
    }
    console.log();
  }

  process.exit(0);
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const enKeys = extractKeys(EN_FILE);
const enKeyValues = extractKeyValues(EN_FILE);
let exitCode = 0;

if (mode === "--find") {
  runFindMode(query, enKeyValues);
}

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

// --- 2a. Source-first defaults ---
if (shouldRun("--source-first")) {
  console.log("=== Source-first defaults (td) ===");
  const sourceFiles = collectSourceFiles(APP_SRC, (dir) => dir.includes("locales"));
  const { defaults: sourceFirstDefaults, conflicts } = extractSourceFirstDefaults(sourceFiles);
  const { keyFirstCalls, aliasMissingDefaults } = collectSourceFirstCoverageIssues(sourceFiles, enKeyValues);
  const missing = [];
  const mismatched = [];

  for (const [key, data] of sourceFirstDefaults) {
    const enValue = enKeyValues.get(key);
    if (enValue == null) {
      missing.push({ key, ...data.refs[0] });
      continue;
    }

    if (enValue !== data.value) {
      mismatched.push({ key, enValue, ...data.refs[0] });
    }
  }

  if (conflicts.length === 0 && missing.length === 0 && mismatched.length === 0 && keyFirstCalls.length === 0 && aliasMissingDefaults.length === 0) {
    console.log(`  ✓ ${sourceFirstDefaults.size} source-first defaults match en.ts`);
    console.log("  ✓ all static i18n callsites carry inline English defaults");
  } else {
    exitCode = 1;

    if (conflicts.length > 0) {
      console.log(`  ✗ ${conflicts.length} conflicting td() defaults`);
      if (mode !== "--summary") {
        for (const conflict of conflicts.slice(0, 10)) {
          console.log(`    ${conflict.key}`);
          console.log(`      first:  ${conflict.original.file}:${conflict.original.line} -> ${JSON.stringify(conflict.expected)}`);
          console.log(`      second: ${conflict.conflicting.file}:${conflict.conflicting.line} -> ${JSON.stringify(conflict.actual)}`);
        }
      }
    }

    if (missing.length > 0) {
      console.log(`  ✗ ${missing.length} td() keys missing from en.ts`);
      if (mode !== "--summary") {
        for (const entry of missing.slice(0, 10)) {
          console.log(`    ${entry.file}:${entry.line} -> ${entry.key} = ${JSON.stringify(entry.value)}`);
        }
      }
    }

    if (mismatched.length > 0) {
      console.log(`  ✗ ${mismatched.length} td() defaults differ from en.ts`);
      if (mode !== "--summary") {
        for (const entry of mismatched.slice(0, 10)) {
          console.log(`    ${entry.file}:${entry.line} -> ${entry.key}`);
          console.log(`      inline: ${JSON.stringify(entry.value)}`);
          console.log(`      en.ts:  ${JSON.stringify(entry.enValue)}`);
        }
      }
    }

    if (keyFirstCalls.length > 0) {
      console.log(`  ✗ ${keyFirstCalls.length} static t() calls still need inline English defaults`);
      if (mode !== "--summary") {
        for (const entry of keyFirstCalls.slice(0, 10)) {
          console.log(`    ${entry.file}:${entry.line} -> ${entry.text.slice(0, 140)}`);
        }
      }
    }

    if (aliasMissingDefaults.length > 0) {
      console.log(`  ✗ ${aliasMissingDefaults.length} translate/tr callsites still need inline English defaults`);
      if (mode !== "--summary") {
        for (const entry of aliasMissingDefaults.slice(0, 10)) {
          console.log(`    ${entry.file}:${entry.line} -> ${entry.text.slice(0, 140)}`);
        }
      }
    }
  }
  console.log();
}

if (mode === "--extract-source-first") {
  console.log("=== Extract source-first defaults into en.ts ===");
  const sourceFiles = collectSourceFiles(APP_SRC, (dir) => dir.includes("locales"));
  const { defaults: sourceFirstDefaults, conflicts } = extractSourceFirstDefaults(sourceFiles);

  if (conflicts.length > 0) {
    console.log(`  ✗ ${conflicts.length} conflicting td() defaults; resolve before extracting`);
    for (const conflict of conflicts.slice(0, 10)) {
      console.log(`    ${conflict.key}`);
      console.log(`      first:  ${conflict.original.file}:${conflict.original.line} -> ${JSON.stringify(conflict.expected)}`);
      console.log(`      second: ${conflict.conflicting.file}:${conflict.conflicting.line} -> ${JSON.stringify(conflict.actual)}`);
    }
    process.exit(1);
  }

  const { preamble, values } = readLocaleFile(EN_FILE);
  let updated = 0;
  let added = 0;

  for (const [key, data] of sourceFirstDefaults) {
    if (!(key in values)) added++;
    else if (values[key] !== data.value) updated++;
    values[key] = data.value;
  }

  writeLocaleFile(EN_FILE, preamble, values);
  console.log(`  ✓ synced ${sourceFirstDefaults.size} td() defaults into en.ts (${updated} updated, ${added} added)`);
  console.log();
}

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
  const keyRefPattern = /\b(?:t|td|translate|tr)\(\s*"([a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*?)"/g;

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
  const dynamicPattern = /\b(?:t|td|translate|tr)\(\s*(`[^`]*\$\{|[^"'][^,)]*\+)/g;
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
    /\bt\(/, /\btd\(/, /translate\(/, /"connected"/, /"allow"/, /"local"/, /"remote"/,
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
console.log('Run with --find "text", --source-first, --extract-source-first, --missing, --orphan, --duplicates, --unused, --dangling, --placeholders, --hardcoded, --prune, or --sort for a single check.');
process.exit(exitCode);
