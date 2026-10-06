// Writes scripts/modules/module-graph.generated.json, the one module graph the boundary
// checks read (W0-08). Run: pnpm boundaries:graph [--check] [--source bootstrap|license-contracts]
//
//   --check   regenerate in memory and exit 1 if the committed JSON differs (CI drift guard)
//
// TODO(W0-01): switch GRAPH_SOURCE to "license-contracts" once
// packages/license-contracts (MODULE_DEFINITIONS) is merged, delete bootstrap-graph.yaml,
// and regenerate. The source is explicit, not auto-detected, so W0-01 landing never makes
// `--check` fail on unrelated pull requests.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { moduleFolderPath } from "./module-folder-path.mts";

type GraphSource = "bootstrap" | "license-contracts";

const GRAPH_SOURCE: GraphSource = "bootstrap";

// Ids that must never get a folder again (discovery D32, D36, D41, D42).
const RETIRED_MODULE_IDS = [
  "customRoles",
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
  retired: { id: string; folder: string }[];
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const outputPath = resolve(here, "module-graph.generated.json");
const bootstrapPath = resolve(here, "bootstrap-graph.yaml");
const registryPath = resolve(repoRoot, "packages/license-contracts/src/modules.ts");

function idList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseBootstrapGraph(source: string): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  const line = /^-\s+([\w.]+):\s*\{\s*parent:\s*([\w.]+),\s*hard:\s*\[([^\]]*)\],\s*soft:\s*\[([^\]]*)\]/;
  for (const raw of source.split("\n")) {
    if (!raw.startsWith("-")) continue;
    const match = line.exec(raw);
    if (!match) throw new Error(`bootstrap-graph.yaml: cannot parse line: ${raw}`);
    const [, id, parent, hard, soft] = match;
    entries.push({ id, parent: parent === "null" ? null : parent, hard: idList(hard), soft: idList(soft) });
  }
  return entries;
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

async function readLicenseContractsRegistry(): Promise<RegistryEntry[]> {
  if (!existsSync(registryPath)) {
    throw new Error(`GRAPH_SOURCE is "license-contracts" but ${registryPath} does not exist (W0-01 not merged?)`);
  }
  const registry: unknown = await import(pathToFileURL(registryPath).href);
  if (!isRecord(registry) || !isRecord(registry.MODULE_DEFINITIONS)) {
    throw new Error("packages/license-contracts/src/modules.ts must export MODULE_DEFINITIONS");
  }
  return Object.entries(registry.MODULE_DEFINITIONS).map(([id, definition]) => {
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
}

export function buildModuleGraph(entries: RegistryEntry[], source: GraphSource): ModuleGraph {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (byId.size !== entries.length) throw new Error("module registry has duplicate ids");
  for (const entry of entries) {
    if (RETIRED_MODULE_IDS.includes(entry.id)) throw new Error(`${entry.id} is retired and must not be in the registry`);
    const dot = entry.id.lastIndexOf(".");
    const expectedParent = dot === -1 ? null : entry.id.slice(0, dot);
    if (entry.parent !== expectedParent) throw new Error(`${entry.id}: parent must be ${expectedParent}, got ${entry.parent}`);
    for (const dependency of [...entry.hard, ...entry.soft, ...(entry.parent ? [entry.parent] : [])]) {
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

async function main(): Promise<void> {
  const source = parseSource(argument("--source"));
  const entries = source === "bootstrap"
    ? parseBootstrapGraph(readFileSync(bootstrapPath, "utf8"))
    : await readLicenseContractsRegistry();
  const output = `${JSON.stringify(buildModuleGraph(entries, source), null, 2)}\n`;
  if (process.argv.includes("--check")) {
    const committed = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
    if (committed !== output) {
      console.error("module-graph.generated.json is out of date with the module registry. Run `pnpm boundaries:graph` and commit the result.");
      process.exitCode = 1;
      return;
    }
    console.log(`module graph: up to date (${entries.length} modules, source ${source})`);
    return;
  }
  writeFileSync(outputPath, output);
  console.log(`module graph: wrote ${entries.length} modules (source ${source}) to scripts/modules/module-graph.generated.json`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
