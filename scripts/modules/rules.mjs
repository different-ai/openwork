// Builds the dependency-cruiser `forbidden` rules for Den module boundaries (W0-08) from
// the generated module graph. Pure: same inputs, same rules. Exercised by
// scripts/modules/selftest/run.mjs.
//
// Rules (discovery §8.6, D6, reconciliation rule R4):
//   core-imports-module               Core never imports a module (route files may use public.ts)
//   framework-imports-manifest-only   framework files import only a module's manifest entry
//   module:<id>                       a module imports only its own folder, and other module
//                                     folders only through public.ts of its ancestors and its
//                                     declared hard or soft dependencies. Parent -> child is a
//                                     violation (D6). The reverse direction (R4) needs no rule:
//                                     a dependent registers into a registry exported by the
//                                     target's public.ts, which is an allowed import.
//   module-db-boundary:<id>           den-api/den-web module code only touches den-db schema
//                                     folders of its own module, ancestors and dependencies
//   module-db-barrel                  report-only nudge away from the den-db barrels
//   shared-imports-module             Core/shared packages (@openwork/features) never import a
//                                     module folder. Core and every module may import them.
//
// Module ids are location paths with groups (D44). A module's folder is its id path
// (module-folder-path.mts); groups are plain folders that contain module folders and are
// never modules themselves, so no rule targets a group and a group gives its members no
// access to each other. "Parent" always means the nearest ancestor that is a module, so
// `library.connectors.native.googleWorkspace` (folder library/connectors/native/google-workspace)
// is a sub-module of `library.connectors` and is excluded from its parent's own folder.

const TEST_FILES = ["\\.test\\.tsx?$", "/__fixtures__/", "/__tests__/"];

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The three module roots. `prefix` relocates them (the self-test uses a fixture tree).
 * `core` is the part of the package that counts as Core when it is outside a module folder.
 */
export function moduleRoots(prefix = "") {
  const p = escapeRegex(prefix);
  return [
    {
      name: "den-api",
      core: `^${p}ee/apps/den-api/src/`,
      moduleRoot: `${prefix}ee/apps/den-api/src/modules`,
      marker: ["module.ts"],
      frameworkFiles: [`^${p}ee/apps/den-api/src/modules/[^/]+\\.tsx?$`],
      frameworkEntry: "/module\\.tsx?$",
      publicEntry: "public\\.tsx?$",
      routeFiles: null,
      db: false,
    },
    {
      name: "den-web",
      core: `^${p}ee/apps/den-web/(?:app|components)/`,
      moduleRoot: `${prefix}ee/apps/den-web/app/(den)/dashboard/_modules`,
      marker: ["manifest.ts", "manifest.tsx"],
      frameworkFiles: [`^${p}ee/apps/den-web/app/\\(den\\)/dashboard/_modules/[^/]+\\.tsx?$`],
      frameworkEntry: "/manifest\\.tsx?$",
      publicEntry: "public\\.tsx?$",
      routeFiles: `^${p}ee/apps/den-web/app/.+/(?:page|layout|loading|error|not-found|template|default)\\.tsx?$`,
      db: false,
    },
    {
      name: "den-db",
      core: `^${p}ee/packages/den-db/src/`,
      moduleRoot: `${prefix}ee/packages/den-db/src/schema`,
      marker: ["index.ts"],
      frameworkFiles: [`^${p}ee/packages/den-db/src/(?:schema|index)\\.ts$`, `^${p}ee/packages/den-db/src/schema/index\\.ts$`],
      frameworkEntry: "/index\\.ts$",
      publicEntry: "index\\.ts$",
      routeFiles: null,
      db: true,
    },
  ];
}

/**
 * Core/shared workspace packages: anyone (Core and every module) may import them, and they
 * never import a module folder. `prefix` relocates them like moduleRoots().
 */
export function sharedPackages(prefix = "") {
  const p = escapeRegex(prefix);
  return [{ name: "@openwork/features", path: `^${p}packages/features/src/`, cruiseRoot: `${prefix}packages/features/src` }];
}

function alternation(values) {
  return values.length === 1 ? values[0] : `(?:${values.join("|")})`;
}

function relativeTo(parentFolder, childFolder) {
  return childFolder.slice(parentFolder.length + 1);
}

/** `^<root>/<folder>/` minus the given descendant folders (each gets its own rule). */
function folderExcluding(root, folder, excludedDescendants) {
  const base = `^${escapeRegex(root)}/${escapeRegex(folder)}/`;
  if (excludedDescendants.length === 0) return base;
  return `${base}(?!${alternation(excludedDescendants.map((d) => escapeRegex(relativeTo(folder, d))))}/)`;
}

function severityFor(enforced) {
  return enforced ? "error" : "warn";
}

/**
 * @param {{ graph: { modules: { id: string, folder: string, parent: string | null, ancestors: string[], hard: string[], soft: string[] }[], groups?: { id: string, folder: string }[] },
 *           enforced: { core: boolean, modules: string[] },
 *           roots: ReturnType<typeof moduleRoots>,
 *           shared?: ReturnType<typeof sharedPackages> }} input
 */
export function buildModuleRules({ graph, enforced, roots, shared = [] }) {
  const modules = graph.modules;
  if (modules.length === 0) return [];
  const byId = new Map(modules.map((module) => [module.id, module]));
  const childrenOf = (id) => modules.filter((module) => module.parent === id);
  const descendantsOf = (id) => modules.filter((module) => module.ancestors.includes(id));
  // Folders of modules without a parent. Every sub-module folder sits inside its parent's
  // folder, so these cover all module code. Group folders (D44) are not modules: only the
  // module folders inside them are matched.
  const rootFolders = modules.filter((module) => module.parent === null).map((module) => escapeRegex(module.folder)).sort();
  const anyModule = (root) => `^${escapeRegex(root.moduleRoot)}/${alternation(rootFolders)}/`;
  const allModuleRoots = `^${alternation(roots.map((root) => escapeRegex(root.moduleRoot)))}/${alternation(rootFolders)}/`;
  const allFolders = alternation(modules.map((module) => escapeRegex(module.folder)));
  const dbRoot = roots.find((root) => root.db);
  const coreSeverity = severityFor(enforced.core);
  const rules = [];

  for (const root of roots) {
    const coreExclusions = [anyModule(root), ...root.frameworkFiles, ...TEST_FILES];
    rules.push({
      name: "core-imports-module",
      comment: `${root.name}: Core never imports a module (discovery §8.6). Move the code into the module or expose a Core hook.`,
      severity: coreSeverity,
      from: { path: root.core, pathNot: root.routeFiles ? [...coreExclusions, root.routeFiles] : coreExclusions },
      to: { path: allModuleRoots },
    });
    if (root.routeFiles) {
      rules.push({
        name: "core-route-imports-module-internals",
        comment: `${root.name}: Next route files may import a module only through its public entry.`,
        severity: coreSeverity,
        from: { path: root.routeFiles, pathNot: [anyModule(root), ...TEST_FILES] },
        to: { path: allModuleRoots, pathNot: `^${escapeRegex(root.moduleRoot)}/${allFolders}/${root.publicEntry}` },
      });
    }
    rules.push({
      name: "framework-imports-manifest-only",
      comment: `${root.name}: framework files may import only a module's manifest entry (${root.frameworkEntry}).`,
      severity: "error",
      from: { path: root.frameworkFiles },
      to: { path: anyModule(root), pathNot: root.frameworkEntry },
    });
  }

  for (const pkg of shared) {
    rules.push({
      name: "shared-imports-module",
      comment: `${pkg.name}: a Core/shared package never imports a module folder (Core and every module import it, not the reverse).`,
      severity: "error",
      from: { path: pkg.path },
      to: { path: allModuleRoots },
    });
  }

  for (const module of modules) {
    const severity = severityFor(enforced.modules.includes(module.id));
    const children = childrenOf(module.id).map((child) => child.folder);
    const allowed = [...module.ancestors, ...module.hard, ...module.soft];
    for (const root of roots) {
      const own = folderExcluding(root.moduleRoot, module.folder, children);
      rules.push({
        name: `module:${module.id}`,
        comment: `${root.name}: ${module.id} may import other modules only through public entries of ${allowed.length ? allowed.join(", ") : "nothing (no declared dependencies)"}; never its sub-modules (D6).`,
        severity,
        from: { path: own },
        to: {
          path: anyModule(root),
          pathNot: [
            own,
            ...allowed.map((id) => `^${escapeRegex(root.moduleRoot)}/${escapeRegex(byId.get(id).folder)}/${root.publicEntry}`),
          ],
        },
      });
    }
    if (!dbRoot) continue;
    const reachable = new Set([module.id, ...allowed]);
    const forbidden = modules.filter((other) => !reachable.has(other.id));
    if (forbidden.length === 0) continue;
    const forbiddenPaths = forbidden.map((other) => {
      const allowedBelow = descendantsOf(other.id).filter((d) => reachable.has(d.id)).map((d) => d.folder);
      return folderExcluding(dbRoot.moduleRoot, other.folder, allowedBelow).replace(/^\^/, "");
    });
    for (const root of roots.filter((candidate) => !candidate.db)) {
      rules.push({
        name: `module-db-boundary:${module.id}`,
        comment: `${root.name}: ${module.id} may only use den-db schema folders of itself, its ancestors and its declared dependencies.`,
        severity,
        from: { path: folderExcluding(root.moduleRoot, module.folder, children) },
        to: { path: `^${alternation(forbiddenPaths)}` },
      });
    }
  }

  if (dbRoot) {
    const dbBase = dbRoot.moduleRoot.slice(0, -"/schema".length);
    for (const root of roots.filter((candidate) => !candidate.db)) {
      rules.push({
        name: "module-db-barrel",
        comment: `${root.name}: module code imports a den-db barrel; prefer a per-module subpath export (W0-08 open question 2).`,
        severity: "warn",
        from: { path: anyModule(root) },
        to: { path: `^${escapeRegex(dbBase)}/(?:schema|index|schema/index)\\.ts$` },
      });
    }
  }

  return rules;
}
