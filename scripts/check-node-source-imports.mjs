#!/usr/bin/env node
// Guard for the services that run in plain Node in production (see SERVICES).
//
// Their own code is compiled, but many workspace exports they import are served
// straight from TypeScript source ("default": "./src/x.ts" in the package's
// exports). In production Node only strips the types from those files. It does
// not do what tsx, Vite, Next and TypeScript's "Bundler" resolution do in
// development, tests and typecheck, so all of these pass there and fail only
// when the deployed service starts:
//
//   - a relative import without its real file name ("./sibling", "./sibling.js")
//   - a type imported or re-exported without `type`
//   - syntax that needs compiling (enum, namespace, parameter properties)
//   - a .tsx file
//
// This check follows every import a service keeps at runtime into the source
// Node will load and reports those cases. It only reads files: no build, and
// nothing is executed. Each service's build still loads the modules for real
// (ee/apps/den-api/scripts/build.mjs), which is the backstop, after merge.
//
// Usage: node scripts/check-node-source-imports.mjs [--list]

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(scriptPath), "..")

/**
 * Workspace apps started with plain `node` on compiled, unbundled output. An
 * app that bundles its server (esbuild, Next, Vite) inlines its workspace
 * imports and does not belong here. Add a new unbundled Node service.
 */
export const SERVICES = ["ee/apps/den-api", "ee/apps/gateway"]

const WORKSPACES = ["apps", "packages", "ee/apps", "ee/packages"]
const SOURCE = /\.[cm]?tsx?$/
const TEST_FILE = /(^|\/)(tests?|__tests__|test-utils?|fixtures)\/|\.(test|spec|test-d)\.[cm]?[jt]sx?$/

function loadTypeScript(root) {
  return createRequire(pathToFileURL(path.join(root, "package.json")))("typescript")
}

/** name -> { name, dir (absolute), exports } for every workspace package. */
export function workspacePackages(root = repoRoot) {
  const packages = new Map()
  for (const parent of WORKSPACES) {
    const parentDir = path.join(root, parent)
    if (!existsSync(parentDir)) continue
    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      const manifest = path.join(parentDir, entry.name, "package.json")
      if (!entry.isDirectory() || !existsSync(manifest)) continue
      const body = JSON.parse(readFileSync(manifest, "utf8"))
      if (typeof body.name === "string") packages.set(body.name, { name: body.name, dir: path.join(parentDir, entry.name), exports: body.exports })
    }
  }
  return packages
}

/** The file Node picks for an export in production: no `development` condition. */
function productionTarget(value) {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(productionTarget).find(Boolean)
  if (!value || typeof value !== "object") return undefined
  for (const [condition, target] of Object.entries(value)) {
    if (!["node", "import", "default"].includes(condition)) continue
    const resolved = productionTarget(target)
    if (resolved) return resolved
  }
  return undefined
}

function exportEntries(pkg) {
  const exports = pkg.exports
  if (exports && typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith("."))) return Object.entries(exports)
  return exports === undefined ? [] : [[".", exports]]
}

/** "@scope/name/sub/path" -> { pkg, subpath: "./sub/path" }, or undefined for anything outside the workspace. */
function workspaceSpecifier(specifier, packages) {
  const parts = specifier.split("/")
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
  const pkg = packages.get(name)
  if (!pkg) return undefined
  const rest = specifier.slice(name.length)
  return { pkg, subpath: rest ? `.${rest}` : "." }
}

/** Absolute production file of a package export, or undefined when the package does not export it to Node. */
function resolveExport(pkg, subpath) {
  for (const [key, value] of exportEntries(pkg)) {
    if (key === subpath) {
      const target = productionTarget(value)
      return target ? path.resolve(pkg.dir, target) : undefined
    }
  }
  for (const [key, value] of exportEntries(pkg)) {
    const star = key.indexOf("*")
    if (star === -1 || !subpath.startsWith(key.slice(0, star)) || !subpath.endsWith(key.slice(star + 1))) continue
    const match = subpath.slice(star, subpath.length - (key.length - star - 1))
    const target = productionTarget(value)
    return target ? path.resolve(pkg.dir, target.replaceAll("*", match)) : undefined
  }
  return undefined
}

function isFile(file) {
  return existsSync(file) && statSync(file).isFile()
}

function sourceFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(entryPath)
    return SOURCE.test(entry.name) && !entry.name.endsWith(".d.ts") ? [entryPath] : []
  })
}

function hasModifier(ts, node, kind) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === kind))
}

/**
 * What a file keeps at runtime once its types are removed, and what it exports.
 * `erased: "node"` keeps what Node's type stripping keeps (only syntax marked
 * `type` goes). Compiled service code is read after TypeScript's own emit, so
 * it uses the same reader on JavaScript.
 */
function readModule(ts, file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : undefined)
  const line = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const imports = []
  const unsupported = []
  const valueExports = new Set()
  const typeExports = new Set()
  let exportsEverything = false

  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      imports.push({ specifier: node.arguments[0].text, line: line(node), names: [] })
    }
    if (ts.isParameter(node) && ts.isConstructorDeclaration(node.parent) && node.modifiers?.some((modifier) => ts.isParameterPropertyModifier(modifier.kind))) {
      unsupported.push({ line: line(node), what: "a constructor parameter property" })
    }
    ts.forEachChild(node, visit)
  }

  for (const statement of source.statements) {
    const declared = hasModifier(ts, statement, ts.SyntaxKind.DeclareKeyword)
    const exported = hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword)
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const clause = statement.importClause
      if (clause?.isTypeOnly) continue
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : []
      const names = named.filter((element) => !element.isTypeOnly).map((element) => (element.propertyName ?? element.name).text)
      // `import { type A, type B } from "x"` still loads "x" under Node's type stripping.
      imports.push({ specifier: statement.moduleSpecifier.text, line: line(statement.moduleSpecifier), names })
      continue
    }
    if (ts.isExportDeclaration(statement)) {
      const named = statement.exportClause && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements : []
      for (const element of named) (statement.isTypeOnly || element.isTypeOnly ? typeExports : valueExports).add(element.name.text)
      if (!statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier) || statement.isTypeOnly) continue
      if (!statement.exportClause) exportsEverything = true
      else if (!ts.isNamedExports(statement.exportClause)) valueExports.add(statement.exportClause.name.text)
      const names = named.filter((element) => !element.isTypeOnly).map((element) => (element.propertyName ?? element.name).text)
      imports.push({ specifier: statement.moduleSpecifier.text, line: line(statement.moduleSpecifier), names })
      continue
    }
    if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly) unsupported.push({ line: line(statement), what: "`import x = …`" })
    if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals) unsupported.push({ line: line(statement), what: "`export = …`" })
      else valueExports.add("default")
    }
    if (ts.isEnumDeclaration(statement) && !declared) unsupported.push({ line: line(statement), what: "an enum" })
    if (ts.isModuleDeclaration(statement) && !declared && ts.isIdentifier(statement.name) && statement.body && ts.isModuleBlock(statement.body)
      && statement.body.statements.some((inner) => !ts.isInterfaceDeclaration(inner) && !ts.isTypeAliasDeclaration(inner))) {
      unsupported.push({ line: line(statement), what: "a namespace with values" })
    }
    if (exported) {
      const isDefault = hasModifier(ts, statement, ts.SyntaxKind.DefaultKeyword)
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) typeExports.add(isDefault ? "default" : statement.name.text)
      else if (ts.isVariableStatement(statement)) {
        const collect = (name) => {
          if (ts.isIdentifier(name)) valueExports.add(name.text)
          else for (const element of name.elements) if (!ts.isOmittedExpression(element)) collect(element.name)
        }
        for (const declaration of statement.declarationList.declarations) collect(declaration.name)
      } else if (isDefault) valueExports.add("default")
      else if (statement.name && ts.isIdentifier(statement.name)) valueExports.add(statement.name.text)
    }
    visit(statement)
  }
  return { imports, unsupported, valueExports, typeExports, exportsEverything }
}

/** Workspace imports that survive TypeScript's emit of a service's own source (what its compiled output imports). */
function serviceImports(ts, serviceDir, packages) {
  const found = []
  for (const file of sourceFiles(path.join(serviceDir, "src"))) {
    if (TEST_FILE.test(path.relative(serviceDir, file))) continue
    const text = readFileSync(file, "utf8")
    // Skip the emit for files that mention no workspace package at all.
    if (![...packages.keys()].some((name) => text.includes(name))) continue
    const emitted = ts.transpileModule(text, {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText
    for (const entry of readModule(ts, file.replace(SOURCE, ".js"), emitted).imports) {
      if (workspaceSpecifier(entry.specifier, packages)) found.push({ ...entry, file })
    }
  }
  return found
}

function relativeHint(file, specifier, pkg) {
  const base = path.resolve(path.dirname(file), specifier)
  const stem = base.replace(/\.[cm]?jsx?$/, "")
  const real = [`${base}.ts`, `${stem}.ts`, `${base}.tsx`, `${stem}.tsx`, path.join(base, "index.ts")].find(isFile)
  if (!real) return "That file does not exist."
  const realSpecifier = (() => {
    const relative = path.relative(path.dirname(file), real).split(path.sep).join("/")
    return relative.startsWith(".") ? relative : `./${relative}`
  })()
  // The package's own export of that file, whichever condition serves the source.
  const targets = (value) => (typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(targets) : [])
  const exported = pkg && exportEntries(pkg).find(([key, value]) => !key.includes("*") && targets(value).some((target) => path.resolve(pkg.dir, target) === real))
  const byName = exported ? `${pkg.name}${exported[0].slice(1)}` : undefined
  return byName
    ? `Import it by package name: "${byName}".`
    : `Import it by its real file name ("${realSpecifier}"), or export it from ${pkg?.name ?? "its package"} and import it by package name.`
}

/**
 * Follows a service's runtime imports through source-served workspace exports.
 * Returns problems as { file, line, message, service, via }.
 */
export function checkService(serviceDir, { root = repoRoot, packages = workspacePackages(root), ts = loadTypeScript(root) } = {}) {
  const absoluteServiceDir = path.resolve(root, serviceDir)
  if (!existsSync(path.join(absoluteServiceDir, "package.json"))) throw new Error(`${serviceDir} is not a workspace package; update SERVICES in scripts/check-node-source-imports.mjs`)
  const service = path.relative(root, absoluteServiceDir).split(path.sep).join("/")
  const rel = (file) => path.relative(root, file).split(path.sep).join("/")
  const problems = []
  const modules = new Map()
  const checked = new Set()
  const entries = new Map()

  const moduleOf = (file) => {
    if (!modules.has(file)) modules.set(file, readModule(ts, file, readFileSync(file, "utf8")))
    return modules.get(file)
  }
  const owner = (file) => [...packages.values()].find((pkg) => file.startsWith(`${pkg.dir}${path.sep}`))

  /** Names imported from a module that exports them only as types: Node's type stripping keeps the import. */
  const typeOnlyNames = (target, names) => {
    if (!SOURCE.test(target) || !isFile(target)) return []
    const { valueExports, typeExports, exportsEverything } = moduleOf(target)
    return exportsEverything ? [] : names.filter((name) => typeExports.has(name) && !valueExports.has(name))
  }

  // `seen` is per entry, so a broken file is reported for every export that reaches it.
  const walk = (file, via, seen) => {
    if (seen.has(file)) return
    seen.add(file)
    checked.add(file)
    if (file.endsWith("x")) {
      problems.push({ file, line: 1, via, message: "is a .tsx file, which Node cannot load. Serve this export from a build (dist) instead." })
      return
    }
    const module = moduleOf(file)
    const pkg = owner(file)
    for (const entry of module.unsupported) {
      problems.push({ file, line: entry.line, via, message: `uses ${entry.what}, which Node cannot run from TypeScript source. Use plain objects, functions and types.` })
    }
    for (const entry of module.imports) {
      let target
      if (entry.specifier.startsWith(".")) {
        target = path.resolve(path.dirname(file), entry.specifier)
        if (!isFile(target)) {
          problems.push({ file, line: entry.line, via, message: `imports "${entry.specifier}", which Node cannot resolve. ${relativeHint(file, entry.specifier, pkg)}` })
          continue
        }
      } else {
        const workspace = workspaceSpecifier(entry.specifier, packages)
        if (!workspace) continue
        target = resolveExport(workspace.pkg, workspace.subpath)
        if (!target) {
          problems.push({ file, line: entry.line, via, message: `imports "${entry.specifier}", which ${workspace.pkg.name} does not export to Node.` })
          continue
        }
      }
      if (!SOURCE.test(target)) continue
      if (!isFile(target)) {
        problems.push({ file, line: entry.line, via, message: `imports "${entry.specifier}", whose file ${rel(target)} does not exist.` })
        continue
      }
      const typeOnly = typeOnlyNames(target, entry.names)
      if (typeOnly.length > 0) {
        problems.push({ file, line: entry.line, via, message: `imports ${typeOnly.map((name) => `\`${name}\``).join(", ")} from "${entry.specifier}" without \`type\`. Node keeps that import and the name does not exist at runtime; write \`type ${typeOnly[0]}\`.` })
      }
      walk(target, via, seen)
    }
  }

  for (const entry of serviceImports(ts, absoluteServiceDir, packages)) {
    const workspace = workspaceSpecifier(entry.specifier, packages)
    const target = resolveExport(workspace.pkg, workspace.subpath)
    // Missing exports and missing dist files are the build's "production exports" check; this one is about source.
    if (!target || !SOURCE.test(target)) continue
    if (entries.has(entry.specifier)) continue
    entries.set(entry.specifier, rel(entry.file))
    const via = `${entry.specifier} (imported by ${entries.get(entry.specifier)})`
    if (!isFile(target)) problems.push({ file: entry.file, line: entry.line, via, message: `imports "${entry.specifier}", whose file ${rel(target)} does not exist.` })
    else walk(target, via, new Set())
  }

  return {
    service,
    entries: [...entries.keys()].sort(),
    files: checked.size,
    problems: problems.map((problem) => ({ ...problem, service, file: rel(problem.file) })),
  }
}

export function formatProblems(results) {
  const byLocation = new Map()
  for (const result of results) {
    for (const problem of result.problems) {
      const key = `${problem.file}:${problem.line} ${problem.message}`
      const entry = byLocation.get(key) ?? { ...problem, services: new Set() }
      entry.services.add(result.service)
      byLocation.set(key, entry)
    }
  }
  const lines = [...byLocation.values()].map((problem) =>
    `- ${problem.file}:${problem.line} ${problem.message}\n    Loaded in production by ${[...problem.services].join(" and ")} through ${problem.via}.`)
  return [
    "Node cannot load these workspace modules from TypeScript source, so the service would fail to build or start in production:",
    "",
    ...lines,
    "",
    "Development, tests and typecheck resolve these imports for you; production Node does not. See \"Modules Node loads from source\" in AGENTS.md.",
  ].join("\n")
}

function main(argv) {
  const packages = workspacePackages()
  const ts = loadTypeScript(repoRoot)
  const results = SERVICES.map((service) => checkService(service, { packages, ts }))
  if (argv.includes("--list")) {
    for (const result of results) console.log(`${result.service}\n${result.entries.map((entry) => `  ${entry}`).join("\n")}`)
    return
  }
  if (results.some((result) => result.problems.length > 0)) {
    console.error(formatProblems(results))
    process.exit(1)
  }
  for (const result of results) console.log(`${result.service}: ${result.entries.length} source-served workspace import(s), ${result.files} file(s) checked.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) main(process.argv.slice(2))
