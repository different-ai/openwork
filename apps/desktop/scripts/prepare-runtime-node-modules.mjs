import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dirnameHere = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(dirnameHere, "..");
const requiredRoots = [{
  name: "@modelcontextprotocol/sdk",
  resolveTarget: "@modelcontextprotocol/sdk/validation/ajv",
}, {
  name: "@openwork/browser-tabs",
}];

function packageRoot(name, fromPackageJson, resolveTarget = name) {
  const requireFromPackage = createRequire(pathToFileURL(fromPackageJson));
  let current;
  try {
    current = dirname(requireFromPackage.resolve(resolveTarget));
  } catch (error) {
    const linkedPackageRoot = resolve(dirname(dirname(fromPackageJson)), name);
    try {
      const linkedPackageJson = JSON.parse(readFileSync(join(linkedPackageRoot, "package.json"), "utf8"));
      if (linkedPackageJson.name === name) return { root: linkedPackageRoot, packageJson: linkedPackageJson };
    } catch {
      // Preserve the original module-resolution error below.
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
    cpSync(resolvedPackage.root, destination, {
      recursive: true,
      dereference: true,
      filter: (source) => source === resolvedPackage.root
        || !relative(resolvedPackage.root, source).split(sep).includes("node_modules"),
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
