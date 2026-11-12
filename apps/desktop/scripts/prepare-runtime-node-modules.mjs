import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dirnameHere = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(dirnameHere, "..");
const requiredRoots = [{
  name: "@openwork/computer-use", resolveTarget: "@openwork/computer-use/computer-control",
}, {
  name: "@modelcontextprotocol/sdk",
  resolveTarget: "@modelcontextprotocol/sdk/validation/ajv",
}, {
  // Imported by Electron's feature-gated session adapter; ensure plain-node
  // ESM is included even when pnpm's workspace collector skips a symlink.
  name: "@openwork/remote-sessions",
}, {
  // The server and the Electron main process import this as plain Node.
  name: "@openwork/types",
}];

function packageRoot(name, fromPackageJson, resolveTarget = name) {
  const requireFromPackage = createRequire(pathToFileURL(fromPackageJson));
  let current;
  try {
    current = dirname(requireFromPackage.resolve(resolveTarget));
  } catch (error) {
    // A dependency may export only subpaths. Find its manifest through Node's
    // normal search directories without requiring a nonexistent root export.
    for (const searchDirectory of requireFromPackage.resolve.paths(name) ?? []) {
      const linkedPackageRoot = resolve(searchDirectory, name);
      try {
        const linkedPackageJson = JSON.parse(readFileSync(join(linkedPackageRoot, "package.json"), "utf8"));
        if (linkedPackageJson.name === name) return { root: linkedPackageRoot, packageJson: linkedPackageJson };
      } catch {
        // Preserve the original module-resolution error if no package matches.
      }
    }
    throw error;
  }
  while (current !== dirname(current)) {
    try {
      const packageJson = JSON.parse(readFileSync(join(current, "package.json"), "utf8"));
      if (packageJson.name === name) return { root: current, packageJson };
    } catch {
      // Keep walking from the resolved entry to its package root.
    }
    current = dirname(current);
  }
  throw new Error(`Could not resolve runtime package root for ${name}.`);
}

/**
 * Where the packaged copy of @openwork/types serves one export from. In the
 * checkout most exports resolve to TypeScript source, which Node refuses to
 * run from node_modules, so there every export points at its compiled file.
 */
export function compiledTypesExports(exports) {
  return Object.fromEntries(Object.entries(exports).map(([subpath, target]) => {
    const source = target.development;
    if (typeof source !== "string" || !/^\.\/src\/.+\.ts$/.test(source)) {
      throw new Error(`@openwork/types export ${subpath} has no TypeScript source under "development".`);
    }
    return [subpath, source.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".js")];
  }));
}

export function stageRuntimeNodeModules(outdir) {
  const output = resolve(outdir);
  const desktopPackageJson = resolve(desktopRoot, "package.json");
  const staged = [];
  const rootPackages = new Map();
  const placements = new Set();
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });

  function stagePackage({ name, fromPackageJson, resolveTarget }, parentDestination, forceRoot = false) {
    const resolvedPackage = packageRoot(name, fromPackageJson, resolveTarget);
    const rootPackage = rootPackages.get(name);
    if (!rootPackage) rootPackages.set(name, resolvedPackage.root);
    if (!forceRoot && rootPackage === resolvedPackage.root) return;
    const nodeModulesRoot = forceRoot || !rootPackage
      ? output
      : resolve(parentDestination, "node_modules");
    const destination = resolve(nodeModulesRoot, name);
    const placementKey = `${destination}\0${resolvedPackage.root}`;
    if (placements.has(placementKey)) return;
    placements.add(placementKey);
    mkdirSync(dirname(destination), { recursive: true });
    if (name === "@openwork/types") {
      stageCompiledTypes(resolvedPackage, destination);
      return;
    }
    cpSync(resolvedPackage.root, destination, {
      recursive: true,
      dereference: true,
      filter: (source) => {
        if (source === resolvedPackage.root) return true;
        const parts = relative(resolvedPackage.root, source).split(sep);
        if (parts.includes("node_modules")) return false;
        // The core's published entrypoints are dist (Node) and src (Bun/dev).
        // Do not ship checkout-only tests, tooling or incidental local links.
        if (name === "@openwork/remote-sessions") return ["dist", "src", "package.json"].includes(parts[0]);
        // Native builds ship as a separate helper. Copying this workspace's
        // Swift .build cache into asar would duplicate the compiler artifacts.
        if (name === "@openwork/computer-use") return ["dist", "package.json"].includes(parts[0]) || parts.length === 1 && /\.(?:mjs|d\.mts|py)$/.test(parts[0]) && !parts[0].endsWith(".test.mjs");
        return true;
      },
    });
    staged.push(destination.slice(output.length + 1));
    const dependencies = resolvedPackage.packageJson.dependencies ?? {};
    for (const dependencyName of Object.keys(dependencies)) {
      stagePackage(
        { name: dependencyName, fromPackageJson: resolve(resolvedPackage.root, "package.json") },
        destination,
      );
    }
  }

  // Ship compiled JavaScript for every @openwork/types export, so no import
  // of it can reach a TypeScript file whichever export it names.
  function stageCompiledTypes({ root, packageJson }, destination) {
    const exports = compiledTypesExports(packageJson.exports);
    const missing = Object.values(exports).filter((target) => !existsSync(resolve(root, target)));
    if (missing.length > 0) {
      throw new Error(`@openwork/types is not built (run pnpm --filter @openwork/types build). Missing: ${missing.join(", ")}`);
    }
    cpSync(resolve(root, "dist"), resolve(destination, "dist"), {
      recursive: true,
      // Declarations are for the compiler, not the running app.
      filter: (source) => relative(resolve(root, "dist"), source).split(sep)[0] !== "types",
    });
    // The build compiles workspace packages in; only zod stays an import.
    const manifest = { name: packageJson.name, version: packageJson.version, private: true, type: "module", exports, dependencies: { zod: packageJson.dependencies.zod } };
    writeFileSync(resolve(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    staged.push(destination.slice(output.length + 1));
    stagePackage({ name: "zod", fromPackageJson: resolve(root, "package.json") }, destination);
  }

  for (const item of requiredRoots) {
    stagePackage({ ...item, fromPackageJson: desktopPackageJson }, output, true);
  }

  return staged.sort();
}

const outdirIndex = process.argv.indexOf("--outdir");
if (outdirIndex !== -1) {
  const outdir = process.argv[outdirIndex + 1];
  if (!outdir) throw new Error("--outdir requires a path.");
  process.stdout.write(`${JSON.stringify({ staged: stageRuntimeNodeModules(outdir) })}\n`);
}
