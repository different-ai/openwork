// Folder <-> registry consistency for Den modules (W0-08). Run: node scripts/modules/check-module-folders.mjs
//
// A module folder is a directory under a module root that contains the root's marker file
// (den-api `module.ts`, den-web `manifest.ts(x)`, den-db `index.ts`). Fails when:
//   - a module folder maps to no registry id (this also catches a sub-module nested under the
//     wrong parent, because folders follow the parent chain: ai-gateway/usage-limits)
//   - a retired id has a folder
//   - enforced-modules.json names an unknown id, is not sorted, or an enforced module still
//     has entries in known-violations.json (an enforced module must be clean, not baselined)
//   - a group folder (D44: `org/`, `library/connectors/native/`, ...) holds anything but module
//     and group folders: no files, no marker file of its own, no other directories (for
//     example `org/teams/` instead of `org/members/teams/`). Groups are namespaces, never modules.
// den-db only checks folders directly under schema/ that are not inside a module, because
// `index.ts` is a common file name inside a module's own schema folder.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { moduleRoots } from "./rules.mjs";

const SKIPPED_DIRECTORIES = new Set(["node_modules", "__tests__", "__fixtures__"]);

function moduleFolderCandidates(directory, markers, relative = "") {
  if (!existsSync(directory)) return [];
  const entries = readdirSync(directory, { withFileTypes: true });
  const found = relative && entries.some((entry) => entry.isFile() && markers.includes(entry.name)) ? [relative] : [];
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    found.push(...moduleFolderCandidates(join(directory, entry.name), markers, relative ? `${relative}/${entry.name}` : entry.name));
  }
  return found;
}

function ownsPath(module, root, path, graph) {
  const own = `${root.moduleRoot}/${module.folder}/`;
  if (!path.startsWith(own)) return false;
  return !graph.modules.some((child) => child.parent === module.id && path.startsWith(`${root.moduleRoot}/${child.folder}/`));
}

/**
 * @param {{ repoRoot: string, prefix?: string, graph: { modules: { id: string, folder: string, parent: string | null }[], groups?: { id: string, folder: string }[], retired: { id: string, folder: string }[] },
 *           enforced: { core: boolean, modules: string[] }, baseline: { from: string, rule: { name: string } }[] }} input
 * @returns {string[]} errors
 */
export function checkModuleFolders({ repoRoot, prefix = "", graph, enforced, baseline }) {
  const errors = [];
  const folders = new Map(graph.modules.map((module) => [module.folder, module.id]));
  const groups = new Map((graph.groups ?? []).map((group) => [group.folder, group.id]));
  const retired = new Map(graph.retired.map((module) => [module.folder, module.id]));
  const roots = moduleRoots(prefix);

  for (const root of roots) {
    let candidates = moduleFolderCandidates(resolve(repoRoot, root.moduleRoot), root.marker);
    if (root.db) {
      candidates = candidates.filter((candidate) => folders.has(candidate) || ![...folders.keys()].some((folder) => candidate.startsWith(`${folder}/`)));
    }
    const reported = new Set();
    for (const candidate of candidates) {
      const path = `${root.moduleRoot}/${candidate}`.slice(prefix.length);
      if (folders.has(candidate)) continue;
      reported.add(candidate);
      if (groups.has(candidate)) {
        errors.push(`${path}: is the folder of group ${groups.get(candidate)}, which is a namespace, never a module (D44); move the ${root.marker.join("/")} into a module folder`);
        continue;
      }
      if (retired.has(candidate)) {
        errors.push(`${path}: belongs to retired module id ${retired.get(candidate)}; move its code to the module that replaced it`);
        continue;
      }
      const leaf = candidate.split("/").pop();
      const likely = [...folders.keys()].filter((folder) => folder.split("/").pop() === leaf);
      const hint = likely.length > 0 ? ` Did you mean ${likely.map((folder) => `${folder} (${folders.get(folder)})`).join(" or ")}? Sub-modules nest inside their parent's folder.` : "";
      errors.push(`${path}: has a ${root.marker.join("/")} but maps to no module registry id.${hint}`);
    }
    for (const [groupFolder, groupId] of groups) {
      const directory = resolve(repoRoot, root.moduleRoot, groupFolder);
      if (!existsSync(directory)) continue;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const relative = `${groupFolder}/${entry.name}`;
        const path = `${root.moduleRoot}/${relative}`.slice(prefix.length);
        if (entry.isDirectory() && (folders.has(relative) || groups.has(relative) || reported.has(relative))) continue;
        if (entry.isDirectory() && [...reported].some((candidate) => candidate.startsWith(`${relative}/`))) continue;
        if (entry.isFile() && root.marker.includes(entry.name) && reported.has(groupFolder)) continue;
        const inside = graph.modules.filter((module) => module.folder.startsWith(`${groupFolder}/`)).map((module) => module.folder);
        errors.push(`${path}: is inside group ${groupId} (D44), which may only hold module or group folders (${inside.join(", ")}); move it into a module folder`);
      }
    }
  }

  const known = new Set(graph.modules.map((module) => module.id));
  for (const id of enforced.modules) {
    if (!known.has(id)) errors.push(`enforced-modules.json lists ${id}, which is not a module registry id`);
  }
  const sorted = [...enforced.modules].sort((a, b) => a.localeCompare(b));
  if (sorted.some((id, index) => id !== enforced.modules[index])) {
    errors.push("enforced-modules.json `modules` is not sorted; keep it sorted to avoid merge conflicts");
  }
  for (const id of enforced.modules) {
    const module = graph.modules.find((candidate) => candidate.id === id);
    if (!module) continue;
    const entries = baseline.filter((entry) =>
      entry.rule.name === `module:${id}`
      || entry.rule.name === `module-db-boundary:${id}`
      || roots.some((root) => ownsPath(module, root, entry.from, graph)));
    if (entries.length > 0) {
      errors.push(`${id} is enforced but has ${entries.length} entries in known-violations.json; fix them (an enforced module must be clean, not baselined)`);
    }
  }
  return errors;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (name) => JSON.parse(readFileSync(resolve(here, name), "utf8"));
  const errors = checkModuleFolders({
    repoRoot: resolve(here, "../.."),
    graph: read("module-graph.generated.json"),
    enforced: read("enforced-modules.json"),
    baseline: read("known-violations.json"),
  });
  if (errors.length > 0) {
    console.error(`check-module-folders failed:\n- ${errors.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log("check-module-folders: every module folder matches the module registry");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
