import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const srcRoot = fileURLToPath(new URL("../src", import.meta.url))

const routeMethods = ["get", "post", "patch", "put", "delete", "all", "on"]
const accessPolicyMarkers = [
  "publicRoute",
  "authenticatedRoute",
  "userSessionRoute",
  "orgMemberRoute",
  "orgRoleRoute",
  "adminRoute",
  "signedWebhookRoute",
  "tokenRoute",
  "cloudTransportRoute",
  "delegatedRoute",
]

type RouteCall = {
  filePath: string
  line: number
  call: string
}

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      return listTypeScriptFiles(entryPath)
    }

    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : []
  })
}

function parseRouteCalls(filePath: string, source: string): RouteCall[] {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  const calls: RouteCall[] = []

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression
      const isStaticRoute = ts.isPropertyAccessExpression(expression)
        && ts.isIdentifier(expression.expression)
        && expression.expression.text === "app"
        && routeMethods.includes(expression.name.text)
      const isDynamicRoute = ts.isElementAccessExpression(expression)
        && ts.isIdentifier(expression.expression)
        && expression.expression.text === "routeApp"
        && ts.isIdentifier(expression.argumentExpression)
        && expression.argumentExpression.text === "method"

      if (isStaticRoute || isDynamicRoute) {
        const start = node.getStart(sourceFile)
        const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1
        calls.push({ filePath, line, call: node.getText(sourceFile) })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return calls
}

function findRouteCalls(filePath: string): RouteCall[] {
  return parseRouteCalls(filePath, readFileSync(filePath, "utf8"))
}

const policyPrinter = ts.createPrinter({ removeComments: true })

function normalizedPolicySyntax(source: string) {
  return policyPrinter.printFile(ts.createSourceFile("policy.ts", source, ts.ScriptTarget.Latest))
}

const runnerGuardSyntax = normalizedPolicySyntax(`
  const identity = await authenticateRunner(c)
  if (!identity) return c.json({ error: "runner_unauthorized" }, 401)
`)

function routeRegistration(route: RouteCall) {
  const sourceFile = ts.createSourceFile(route.filePath, route.call, ts.ScriptTarget.Latest)
  const statement = sourceFile.statements[0]
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return null
  return { sourceFile, call: statement.expression }
}

function hasAccessPolicy(route: RouteCall, routes: RouteCall[]): boolean {
  if (accessPolicyMarkers.some((marker) => route.call.includes(marker))) return true
  const registration = routeRegistration(route)
  if (!registration) return false
  const handler = registration.call.arguments.at(-1)
  if (!handler || !ts.isArrowFunction(handler)) return false

  // This reviewed helper re-dispatches to /v1/workflows, whose handlers use orgMemberRoute.
  // It preserves the original Request; neither arbitrary proxy helpers nor app.fetch are guards.
  if (ts.isCallExpression(handler.body)
    && ts.isIdentifier(handler.body.expression)
    && handler.body.expression.text === "proxyWorkflowAlias"
    && handler.body.arguments.length === 2
    && handler.body.arguments[0]?.getText(registration.sourceFile) === "c.req.raw"
    && handler.body.arguments[1]
    && ts.isStringLiteral(handler.body.arguments[1])) return true

  if (!ts.isBlock(handler.body)) return false
  const statements = handler.body.statements
  const syntax = (nodes: readonly ts.Node[]) => normalizedPolicySyntax(
    nodes.map((node) => node.getText(registration.sourceFile)).join("\n"),
  )

  // authenticateRunner verifies HMAC/expiry and active org membership; callers must reject null.
  // Require the leading authentication AND 401 return, not a mere mention or ignored call.
  if (syntax(statements.slice(0, 2)) === runnerGuardSyntax) return true

  // Accept only a pure same-app pathname alias to a locally registered, explicitly guarded target.
  // No route-name exceptions, arbitrary fetches, request overrides, or missing targets qualify.
  if (statements.length !== 3
    || syntax(statements.slice(0, 1)) !== normalizedPolicySyntax("const url = new URL(c.req.raw.url)")
    || syntax(statements.slice(2)) !== normalizedPolicySyntax("return app.fetch(new Request(url, c.req.raw))")) return false
  const assignment = statements[1]
  if (!assignment || !ts.isExpressionStatement(assignment)
    || !ts.isBinaryExpression(assignment.expression)
    || assignment.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    || !ts.isPropertyAccessExpression(assignment.expression.left)
    || !ts.isIdentifier(assignment.expression.left.expression)
    || assignment.expression.left.expression.text !== "url"
    || assignment.expression.left.name.text !== "pathname"
    || !ts.isStringLiteral(assignment.expression.right)) return false
  const targetPath = assignment.expression.right.text
  const targets = routes.filter((candidate) => {
    const target = routeRegistration(candidate)?.call.arguments[0]
    return candidate.filePath === route.filePath && target && ts.isStringLiteral(target) && target.text === targetPath
  })
  return targets.length > 0 && targets.every((target) =>
    accessPolicyMarkers.some((marker) => target.call.includes(marker)))
}

describe("route registration parser", () => {
  test("enumerates every supported HTTP method and dynamic registration", () => {
    const registrations = routeMethods.map((method) => method === "on"
      ? 'app.on("GET", "/route", publicRoute, handler)'
      : `app.${method}("/route", publicRoute, handler)`)
    registrations.push("routeApp[method](path, orgMemberRoute(), ...routeMiddlewares, routeHandler)")

    expect(parseRouteCalls("routes.ts", registrations.join("\n"))).toEqual(
      registrations.map((call, index) => ({ filePath: "routes.ts", line: index + 1, call })),
    )
  })

  test("handles an unmatched comment apostrophe without consuming the next route", () => {
    const call = [
      'app.post("/claim", userSessionRoute(), async (c) => {',
      "  // account's internal ID stored at runtime",
      '  return c.json({ ok: true })',
      '})',
    ].join("\n")
    const nextCall = 'app.get("/next", publicRoute, handler)'

    expect(parseRouteCalls("routes.ts", `${call};\n${nextCall};`)).toEqual([
      { filePath: "routes.ts", line: 1, call },
      { filePath: "routes.ts", line: 5, call: nextCall },
    ])
  })

  test("handles block comments, regex delimiters and nested templates", () => {
    const call = [
      'app.post("/syntax", publicRoute, async (c) => {',
      "  /* unmatched ( and quote ' */",
      '  const pattern = /[)\'"`]/',
      '  const nested = `outer ${format(`inner ${value}`)}`',
      '  return c.json({ matched: pattern.test(nested) })',
      '})',
    ].join("\n")

    expect(parseRouteCalls("routes.ts", call)).toEqual([
      { filePath: "routes.ts", line: 1, call },
    ])
  })

  test("ignores route-like text and unrelated receivers while accepting formatted calls", () => {
    const call = 'app\n  .get<"/actual">\n  ("/actual", publicRoute, handler)'
    const dynamicCall = 'routeApp [ method ] (path, orgMemberRoute(), handler)'
    const source = [
      '// app.get("/comment", handler)',
      '/* routeApp[method]("/comment", handler) */',
      'const text = \'app.post("/string", handler)\'',
      'const template = `app.delete("/template", handler)`',
      'const regex = /app.get("regex")/',
      'other.get("/other", handler)',
      'other.app.get("/property", handler)',
      'myapp.get("/suffix", handler)',
      'app.use("/middleware", handler)',
      'routeApp[otherMethod](path, handler)',
      'other.routeApp[method](path, handler)',
      call,
      dynamicCall,
    ].join("\n")

    expect(parseRouteCalls("routes.ts", source)).toEqual([
      { filePath: "routes.ts", line: 12, call },
      { filePath: "routes.ts", line: 15, call: dynamicCall },
    ])
  })

  test("retains policy checks for unguarded static and dynamic routes", () => {
    const source = [
      'app.get("/missing", handler)',
      'app.get("/session", userSessionRoute(), handler)',
      'routeApp[method](path, handler)',
      'routeApp[method](path, orgMemberRoute(), handler)',
    ].join("\n")
    const routes = parseRouteCalls("routes.ts", source)
    const missingPolicy = routes.filter((route) => !hasAccessPolicy(route, routes))

    expect(missingPolicy.map((route) => route.line)).toEqual([1, 3])
  })
})

describe("equivalent route access policies", () => {
  test("runner authentication requires an awaited identity and immediate 401 rejection before work", () => {
    const authenticate = "const identity = await authenticateRunner(c)"
    const reject = 'if (!identity) return c.json({ error: "runner_unauthorized" }, 401)'
    const bodies = [
      `${authenticate}; ${reject}; return work(identity)`,
      `${authenticate}; return work(identity)`,
      `${authenticate}; if (!identity) c.json({ error: "runner_unauthorized" }, 401); return work(identity)`,
      `${authenticate}; if (!identity) return c.json({ error: "runner_unauthorized" }, 200); return work(identity)`,
      `const identity = authenticateRunner(c); ${reject}; return work(identity)`,
      `await work(); ${authenticate}; ${reject}; return work(identity)`,
    ]
    const routes = parseRouteCalls("routes.ts", bodies.map((body, index) =>
      `app.get("/runner-${index}", async (c) => { ${body} })`).join("\n"))

    expect(routes.map((route) => hasAccessPolicy(route, routes))).toEqual([true, false, false, false, false, false])
  })

  test("recognizes the reviewed Workflow alias helper, not arbitrary helpers or descriptive mentions", () => {
    const routes = parseRouteCalls("routes.ts", [
      'app.all("/legacy", (c) => proxyWorkflowAlias(c.req.raw, "/legacy"))',
      'app.all("/other", (c) => uncheckedProxy(c.req.raw, "/other"))',
      'app.all("/replaced-request", (c) => proxyWorkflowAlias(new Request(c.req.raw), "/replaced-request"))',
      'app.get("/description", describeRoute({ summary: "authenticateRunner proxyWorkflowAlias app.fetch" }), handler)',
    ].join("\n"))

    expect(routes.map((route) => hasAccessPolicy(route, routes))).toEqual([true, false, false, false])
  })

  test("same-app aliases require a guarded local destination and unchanged request", () => {
    const alias = (path: string, target: string, extra = "", request = "new Request(url, c.req.raw)") =>
      `app.all("${path}", (c) => {
        const url = new URL(c.req.raw.url)
        url.pathname = "${target}"
        ${extra}
        return app.fetch(${request})
      })`
    const routes = parseRouteCalls("routes.ts", [
      'app.get("/guarded", orgMemberRoute(), handler)',
      'app.get("/unguarded", handler)',
      alias("/valid-alias", "/guarded"),
      alias("/unguarded-alias", "/unguarded"),
      alias("/unknown-alias", "/unknown"),
      alias("/side-effect", "/guarded", "work()"),
      alias("/override", "/guarded", "", 'new Request(url, { headers: trustedHeaders })'),
      'app.get("/fetch-only", (c) => app.fetch(c.req.raw))',
    ].join("\n"))

    expect(routes.map((route) => hasAccessPolicy(route, routes))).toEqual([true, false, true, false, false, false, false, false])
  })
})

describe("Den API route access policies", () => {
  test("every route declares an explicit or verified equivalent access policy", () => {
    const missingPolicy = listTypeScriptFiles(srcRoot).flatMap((filePath) => {
      const routes = findRouteCalls(filePath)
      return routes.filter((route) => !hasAccessPolicy(route, routes))
    })

    expect(missingPolicy.map((route) => `${route.filePath}:${route.line}`)).toEqual([])
  })

  test("organization analytics requires an admin role", () => {
    const analyticsRoute = findRouteCalls(join(srcRoot, "routes/telemetry/index.ts"))
      .find((route) => route.call.includes('"/v1/telemetry/analytics"'))

    expect(analyticsRoute?.call).toContain('orgRoleRoute(["admin"])')
  })
})
