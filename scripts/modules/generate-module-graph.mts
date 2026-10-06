// Writes scripts/modules/module-graph.generated.json, the one module graph the boundary
// checks read (W0-08). Run: pnpm boundaries:graph [--check | --compare] [--source bootstrap|license-contracts]
//
//   --check            regenerate in memory and exit 1 if the output file differs (CI drift guard)
//   --compare          build from --source and exit 1 if its modules or groups differ from the
//                      committed JSON (ignores the `source` field). Used to prove the bootstrap
//                      copy matches W0-01: --source license-contracts --registry <modules.ts>
//   --registry <path>  modules.ts to read for --source license-contracts (default: the repo copy)
//   --bootstrap <path> bootstrap YAML to read (default: scripts/modules/bootstrap-graph.yaml)
//   --output <path>    JSON to write or check (default: scripts/modules/module-graph.generated.json)
//
// Ids are location paths with groups (discovery D44): every proper prefix of a module id is a
// module or a group, a module's parent is its nearest prefix that is a module, and groups are
// pure namespaces (never parents, never toggled). buildModuleGraph() enforces all of that.
//
// TODO(W0-01): switch GRAPH_SOURCE to "license-contracts" once
// packages/license-contracts (MODULE_DEFINITIONS, MODULE_GROUPS) is merged, delete
// bootstrap-graph.yaml, and regenerate. The source is explicit, not auto-detected, so W0-01
// landing never makes `--check` fail on unrelated pull requests.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { moduleFolderPath } from "./module-folder-path.mts";

type GraphSource = "bootstrap" | "license-contracts";

const GRAPH_SOURCE: GraphSource = "bootstrap";

// D44: ids have at most this many dot-separated camelCase segments.
const MAX_SEGMENTS = 4;
const SEGMENT = /^[a-z][a-zA-Z0-9]*$/;

// Ids that must never get a folder again: retired before D44 (D32, D36, D41, D42) and the
// D44 removals (the `enterpriseAuth` umbrella and `analytics`, R15). Ids renamed by D44 are
// not listed: an old folder name simply maps to no registry id.
const RETIRED_MODULE_IDS = [
  "analytics",
  "customRoles",
  "enterpriseAuth",
  "enterpriseAuth.requireSso",
  "remoteSessions",
  "workflows.generatedViews",
];

type RegistryEntry = {
  id: string;
  parent: string | null;
  hard: string[];
  soft: string[];
};

type Registry = {
  modules: RegistryEntry[];
  groups: string[];
};

export type GraphModule = {
  id: string;
  folder: string;
  parent: string | null;
  ancestors: string[];
  hard: string[];
  soft: string[];
};

export type ModuleGraph = {
  _comment: string;
  source: GraphSource;
  modules: GraphModule[];
  groups: { id: string; folder: string }[];
  retired: { id: string; folder: string }[];
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const defaultOutputPath = resolve(here, "module-graph.generated.json");
const defaultBootstrapPath = resolve(here, "bootstrap-graph.yaml");
const defaultRegistryPath = resolve(repoRoot, "packages/license-contracts/src/modules.ts");

function idList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseBootstrapGraph(source: string): Registry {
  const modules: RegistryEntry[] = [];
  const groups: string[] = [];
  const moduleLine = /^-\s+([\w.]+):\s*\{\s*parent:\s*([\w.]+),\s*hard:\s*\[([^\]]*)\],\s*soft:\s*\[([^\]]*)\]/;
  const groupLine = /^-\s+([\w.]+):\s*\{\s*group:\s*true\s*\}/;
  for (const raw of source.split("\n")) {
    if (!raw.startsWith("-")) continue;
    const group = groupLine.exec(raw);
    if (group) {
      groups.push(group[1]);
      continue;
    }
    const match = moduleLine.exec(raw);
    if (!match) throw new Error(`bootstrap graph: cannot parse line: ${raw}`);
    const [, id, parent, hard, soft] = match;
    modules.push({ id, parent: parent === "null" ? null : parent, hard: idList(hard), soft: idList(soft) });
  }
  return { modules, groups };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return value.filter((item): item is string => typeof item === "string");
}

async function readLicenseContractsRegistry(registryPath: string): Promise<Registry> {
  if (!existsSync(registryPath)) {
    throw new Error(`GRAPH_SOURCE is "license-contracts" but ${registryPath} does not exist (W0-01 not merged?)`);
  }
  const registry: unknown = await import(pathToFileURL(registryPath).href);
  if (!isRecord(registry) || !isRecord(registry.MODULE_DEFINITIONS)) {
    throw new Error(`${registryPath} must export MODULE_DEFINITIONS`);
  }
  const modules = Object.entries(registry.MODULE_DEFINITIONS).map(([id, definition]) => {
    if (!isRecord(definition)) throw new Error(`MODULE_DEFINITIONS.${id} must be an object`);
    const parent = definition.parent;
    if (parent !== null && typeof parent !== "string") throw new Error(`MODULE_DEFINITIONS.${id}.parent must be a string or null`);
    return {
      id,
      parent,
      hard: stringArray(definition.dependsOn, `MODULE_DEFINITIONS.${id}.dependsOn`),
      soft: stringArray(definition.softDependsOn, `MODULE_DEFINITIONS.${id}.softDependsOn`),
    };
  });
  return { modules, groups: stringArray(registry.MODULE_GROUPS, `${registryPath} MODULE_GROUPS`) };
}

/** Every proper prefix of a dotted id, nearest first (`a.b.c` -> `a.b`, `a`). */
function prefixesOf(id: string): string[] {
  const parts = id.split(".");
  const prefixes: string[] = [];
  for (let length = parts.length - 1; length > 0; length -= 1) prefixes.push(parts.slice(0, length).join("."));
  return prefixes;
}

function checkIdShape(id: string, kind: string): void {
  const segments = id.split(".");
  if (segments.length > MAX_SEGMENTS) throw new Error(`${kind} ${id}: more than ${MAX_SEGMENTS} segments (D44)`);
  if (!segments.every((segment) => SEGMENT.test(segment))) throw new Error(`${kind} ${id}: segments must be camelCase (D44)`);
}

export function buildModuleGraph({ modules: entries, groups }: Registry, source: GraphSource): ModuleGraph {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (byId.size !== entries.length) throw new Error("module registry has duplicate ids");
  const groupSet = new Set(groups);
  if (groupSet.size !== groups.length) throw new Error("module registry has duplicate groups");
  for (const group of groups) {
    checkIdShape(group, "group");
    if (byId.has(group)) throw new Error(`${group} is both a group and a module (D44: groups are never modules)`);
    if (RETIRED_MODULE_IDS.includes(group)) throw new Error(`group ${group} reuses retired module id`);
    for (const prefix of prefixesOf(group)) {
      if (!byId.has(prefix) && !groupSet.has(prefix)) throw new Error(`group ${group}: prefix ${prefix} is neither a module nor a group (D44)`);
    }
    if (!entries.some((entry) => entry.id.startsWith(`${group}.`))) throw new Error(`group ${group} contains no module`);
  }
  for (const entry of entries) {
    checkIdShape(entry.id, "module");
    if (RETIRED_MODULE_IDS.includes(entry.id)) throw new Error(`${entry.id} is retired and must not be in the registry`);
    const prefixes = prefixesOf(entry.id);
    for (const prefix of prefixes) {
      if (!byId.has(prefix) && !groupSet.has(prefix)) throw new Error(`${entry.id}: prefix ${prefix} is neither a module nor a group (D44)`);
    }
    const expectedParent = prefixes.find((prefix) => byId.has(prefix)) ?? null;
    if (entry.parent !== expectedParent) {
      throw new Error(`${entry.id}: parent must be the nearest module ancestor ${expectedParent}, got ${entry.parent} (D44: groups are never parents)`);
    }
    for (const dependency of [...entry.hard, ...entry.soft, ...(entry.parent ? [entry.parent] : [])]) {
      if (groupSet.has(dependency)) throw new Error(`${entry.id}: depends on group ${dependency} (D44: groups are never dependencies)`);
      if (!byId.has(dependency)) throw new Error(`${entry.id}: unknown module ${dependency}`);
      if (dependency === entry.id) throw new Error(`${entry.id}: depends on itself`);
    }
  }
  const ancestorsOf = (id: string): string[] => {
    const chain: string[] = [];
    let parent = byId.get(id)?.parent ?? null;
    while (parent) {
      chain.push(parent);
      parent = byId.get(parent)?.parent ?? null;
    }
    return chain;
  };
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  return {
    _comment: "Generated by scripts/modules/generate-module-graph.mts (pnpm boundaries:graph). Do not edit by hand.",
    source,
    modules: sorted.map((entry) => ({
      id: entry.id,
      folder: moduleFolderPath(entry.id),
      parent: entry.parent,
      ancestors: ancestorsOf(entry.id),
      hard: [...entry.hard].sort(),
      soft: [...entry.soft].sort(),
    })),
    groups: [...groups].sort().map((id) => ({ id, folder: moduleFolderPath(id) })),
    retired: [...RETIRED_MODULE_IDS].sort().map((id) => ({ id, folder: moduleFolderPath(id) })),
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function parseSource(value: string | undefined): GraphSource {
  if (value === undefined) return GRAPH_SOURCE;
  if (value === "bootstrap" || value === "license-contracts") return value;
  throw new Error(`--source must be bootstrap or license-contracts, got ${value}`);
}

function withoutSource(json: string): string {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) return json;
  return JSON.stringify({ ...parsed, source: null });
}

async function main(): Promise<void> {
  const source = parseSource(argument("--source"));
  const outputPath = resolve(argument("--output") ?? defaultOutputPath);
  const registry = source === "bootstrap"
    ? parseBootstrapGraph(readFileSync(resolve(argument("--bootstrap") ?? defaultBootstrapPath), "utf8"))
    : await readLicenseContractsRegistry(resolve(argument("--registry") ?? defaultRegistryPath));
  const output = `${JSON.stringify(buildModuleGraph(registry, source), null, 2)}\n`;
  const summary = `${registry.modules.length} modules, ${registry.groups.length} groups, source ${source}`;
  const committed = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  if (process.argv.includes("--compare")) {
    if (!committed || withoutSource(committed) !== withoutSource(output)) {
      console.error(`${outputPath} does not match the module graph built from ${source}.`);
      process.exitCode = 1;
      return;
    }
    console.log(`module graph: identical to ${source} (${summary})`);
    return;
  }
  if (process.argv.includes("--check")) {
    if (committed !== output) {
      console.error(`${outputPath} is out of date with the module registry. Run \`pnpm boundaries:graph\` and commit the result.`);
      process.exitCode = 1;
      return;
    }
    console.log(`module graph: up to date (${summary})`);
    return;
  }
  writeFileSync(outputPath, output);
  console.log(`module graph: wrote ${summary} to ${outputPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
