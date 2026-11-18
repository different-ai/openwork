import ts from "typescript";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Type-check the evals program and report only the diagnostics that belong to it:
 * files under `evals/` plus the files `tsconfig.json` includes explicitly. Sources
 * the specs pull in transitively from `apps/` and `ee/` are compiled by their own
 * projects with their own flags; their diagnostics are not this check's claim.
 */
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const evalsDir = resolve(root, "evals") + sep;
const configPath = resolve(root, "evals/tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, " "));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(root, "evals"), undefined, configPath);
const included = new Set(parsed.fileNames.map((file) => resolve(file)));
const program = ts.createProgram(parsed.fileNames, parsed.options);

function owned(fileName) {
  const file = resolve(fileName);
  if (file.includes(`${sep}node_modules${sep}`)) return false;
  return included.has(file) || file.startsWith(evalsDir);
}

const failures = [];
for (const diagnostic of [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  if (!diagnostic.file || diagnostic.start === undefined) {
    failures.push(`error TS${diagnostic.code}: ${message}`);
    continue;
  }
  if (!owned(diagnostic.file.fileName)) continue;
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  failures.push(`${relative(root, diagnostic.file.fileName)}(${line + 1},${character + 1}): error TS${diagnostic.code}: ${message}`);
}

const checked = program.getSourceFiles().filter((file) => !file.isDeclarationFile && owned(file.fileName)).length;
if (failures.length) {
  console.error([...new Set(failures)].join("\n"));
  console.error(`\n${failures.length} error(s) in evals sources (${checked} files checked).`);
  process.exitCode = 1;
} else {
  console.log(`Type-checked ${checked} evals source files: no errors.`);
}
