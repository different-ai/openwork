import { builtinModules, createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
// The build's parser is tooling only. All imports being checked resolve from
// the isolated packaged tree, never through this require function.
const { parse } = createRequire(new URL("../../server/package.json", import.meta.url))("acorn");

function importedSpecifiers(source) {
  const imports = [];
  const constants = new Map();
  const tree = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  function walk(node, action) {
    if (!node || typeof node !== "object") return;
    action(node);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach((value) => walk(value, action));
      else if (child && typeof child === "object") walk(child, action);
    }
  }
  walk(tree, (node) => {
    if (node.type !== "VariableDeclaration" || node.kind !== "const") return;
    for (const declaration of node.declarations) {
      if (declaration.id.type !== "Identifier") continue;
      const name = declaration.id.name;
      const init = declaration.init;
      const resolved = init?.type === "CallExpression" && init.callee.type === "MemberExpression" && init.callee.property.name === "resolve"
        && (init.callee.object.name === "require" || init.callee.object.type === "CallExpression" && init.callee.object.callee.name === "createRequire");
      const value = init?.type === "Literal" ? init.value : resolved ? init.arguments[0]?.value : null;
      constants.set(name, constants.has(name) ? null : value);
    }
  });
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type) && node.source) {
      const urlImport = node.source.type === "MemberExpression" && node.source.property.name === "href" && node.source.object.type === "CallExpression"
        && node.source.object.callee.name === "pathToFileURL" && node.source.object.arguments[0]?.type === "Identifier";
      const value = node.source.type === "Identifier" ? constants.get(node.source.name) : urlImport ? constants.get(node.source.object.arguments[0].name) : node.source.value;
      if (typeof value !== "string") throw new Error("Packaged sandbox graph has an unresolved dynamic import; declare its runtime dependency explicitly.");
      imports.push(value);
    }
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "require") {
      const value = node.arguments[0]?.value;
      if (typeof value !== "string") throw new Error("Packaged sandbox graph has an unresolved require call.");
      imports.push(value);
    }
  }
  walk(tree, visit);
  return imports;
}

// Run in a separate Node process with --experimental-import-meta-resolve. The
// parent URL is essential: resolution must originate inside the extracted app,
// never in this script's checkout or the build machine's node_modules.
export function verifyPackagedImportGraph(root, entry = "server/dist/local-sandbox-runtime.js") {
  const packageRoot = realpathSync(root);
  const seen = new Set();
  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    // Built ESM retains literal dynamic imports. Native CommonJS loaders use
    // platform-specific branches, whose assets are checked separately below.
    for (const specifier of importedSpecifiers(source)) {
      if (builtins.has(specifier)) continue;
      let target;
      try {
        target = fileURLToPath(import.meta.resolve(specifier, pathToFileURL(file).href));
      } catch (cause) {
        throw new Error(`Packaged runtime cannot resolve ${specifier} imported by ${relative(packageRoot, file)}`, { cause });
      }
      const local = relative(packageRoot, target);
      if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`) || !existsSync(target)) {
        throw new Error(`Packaged runtime import escapes or is missing: ${specifier} from ${relative(packageRoot, file)}`);
      }
      // Server internals have their own packaging boundaries; this check owns
      // the local runtime's external provider graph, including lazy imports.
      if (/\.(?:m?js)$/.test(target) && (local.split(sep).includes("node_modules") || local.split(sep).join("/") === "server/dist/packaged-sandbox-assets.js")) visit(target);
    }
  }
  visit(resolve(packageRoot, entry));
  return [...seen].map((file) => relative(packageRoot, file)).sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) throw new Error("Expected extracted packaged app directory.");
  const files = verifyPackagedImportGraph(root);
  process.stdout.write(`${JSON.stringify({ verifiedRuntimeModules: files.length })}\n`);
}
