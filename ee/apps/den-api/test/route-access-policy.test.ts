import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const srcRoot = new URL("../src", import.meta.url).pathname

const routeMethods = ["get", "post", "patch", "put", "delete", "all", "on"]
const accessPolicyMarkers = [
  "publicRoute",
  "authenticatedRoute",
  "orgMemberRoute",
  "orgRoleRoute",
  "adminRoute",
  "signedWebhookRoute",
  "tokenRoute",
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

function findMatchingParen(source: string, openParenIndex: number) {
  let depth = 0
  let quote: string | null = null
  let escaped = false

  for (let index = openParenIndex; index < source.length; index += 1) {
    const char = source[index]

    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char
      continue
    }

    if (char === "(") {
      depth += 1
    } else if (char === ")") {
      depth -= 1
      if (depth === 0) {
        return index
      }
    }
  }

  throw new Error("Unclosed route registration")
}

function findNextRouteCall(source: string, startIndex: number) {
  let nextRoute: { index: number; method: string } | null = null

  for (const method of routeMethods) {
    const index = source.indexOf(`app.${method}(`, startIndex)
    if (index >= 0 && (!nextRoute || index < nextRoute.index)) {
      nextRoute = { index, method }
    }
  }

  const dynamicRouteIndex = source.indexOf("routeApp[method](", startIndex)
  if (dynamicRouteIndex >= 0 && (!nextRoute || dynamicRouteIndex < nextRoute.index)) {
    nextRoute = { index: dynamicRouteIndex, method: "dynamic" }
  }

  return nextRoute
}

function findRouteCalls(filePath: string): RouteCall[] {
  const source = readFileSync(filePath, "utf8")
  const calls: RouteCall[] = []
  let cursor = 0

  while (true) {
    const route = findNextRouteCall(source, cursor)
    if (!route) {
      return calls
    }

    const openParenIndex = source.indexOf("(", route.index)
    const closeParenIndex = findMatchingParen(source, openParenIndex)
    const call = source.slice(route.index, closeParenIndex + 1)
    const line = source.slice(0, route.index).split("\n").length
    calls.push({ filePath, line, call })
    cursor = closeParenIndex + 1
  }
}

describe("Den API route access policies", () => {
  test("every route declares an explicit access policy", () => {
    const missingPolicy = listTypeScriptFiles(srcRoot)
      .flatMap(findRouteCalls)
      .filter((route) => !accessPolicyMarkers.some((marker) => route.call.includes(marker)))

    expect(missingPolicy.map((route) => `${route.filePath}:${route.line}`)).toEqual([])
  })
})
