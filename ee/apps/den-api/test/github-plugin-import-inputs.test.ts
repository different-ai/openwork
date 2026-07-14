import { beforeAll, describe, expect, test } from "bun:test"
import type { GithubDiscoveredPlugin } from "../src/routes/org/plugin-system/github-discovery.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

type Store = typeof import("../src/routes/org/plugin-system/store.js")

let store: Store

beforeAll(async () => {
  seedRequiredEnv()
  store = await import("../src/routes/org/plugin-system/store.js")
})

function plugin(overrides: Partial<GithubDiscoveredPlugin> = {}): GithubDiscoveredPlugin {
  return {
    componentKinds: ["mcp_server"],
    componentPaths: {
      agents: [],
      commands: [],
      hooks: [],
      lspServers: [],
      mcpServers: [".mcp.json"],
      monitors: [],
      settings: [],
      skills: [],
    },
    description: null,
    displayName: "Example plugin",
    key: "manifest:root",
    manifestPath: null,
    metadata: {},
    rootPath: "",
    selectedByDefault: true,
    sourceKind: "plugin_manifest",
    supported: true,
    warnings: [],
    ...overrides,
  }
}

function expectRouteFailure(error: unknown, code: string) {
  expect(error).toBeInstanceOf(store.PluginArchRouteFailure)
  expect((error as InstanceType<typeof store.PluginArchRouteFailure>).error).toBe(code)
}

describe("public GitHub plugin URL normalization", () => {
  test("canonicalizes only an unadorned HTTPS github.com repository or tree URL", () => {
    expect(store.parsePublicGithubPluginUrl("HTTPS://WWW.GITHUB.COM/Example/Repo.git/")).toEqual({
      canonicalUrl: "https://github.com/example/repo",
      refAndPathSegments: null,
      repositoryFullName: "example/repo",
    })
    expect(store.parsePublicGithubPluginUrl("https://github.com/Example/Repo/tree/feature/oauth/plugin dir")).toEqual({
      canonicalUrl: "https://github.com/example/repo/tree/feature/oauth/plugin%20dir",
      refAndPathSegments: ["feature", "oauth", "plugin dir"],
      repositoryFullName: "example/repo",
    })
  })

  test("rejects alternate schemes, authorities, ports, userinfo, queries, and fragments", () => {
    for (const url of [
      "http://github.com/example/repo",
      "https://git.example/example/repo",
      "https://user@github.com/example/repo",
      "https://github.com:443/example/repo",
      "https://github.com/example/repo?",
      "https://github.com/example/repo?token=secret",
      "https://github.com/example/repo#readme",
    ]) {
      try {
        store.parsePublicGithubPluginUrl(url)
        throw new Error(`expected ${url} to fail`)
      } catch (error) {
        expectRouteFailure(error, "invalid_github_url")
      }
    }
  })
})

describe("GitHub MCP declaration inputs", () => {
  test("bounds map and registry declarations while iterating", () => {
    const declared = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [
      `server-${index}`,
      { url: `https://mcp-${index}.example.test/mcp` },
    ]))
    for (const payload of [
      { mcpServers: declared },
      { remotes: Array.from({ length: 4 }, (_, index) => ({ url: `https://mcp-${index}.example.test/mcp` })) },
      { packages: Array.from({ length: 4 }, () => ({ registryType: "npm" })) },
    ]) {
      try {
        store.mcpServerEntriesFromPayload({
          declarationLimit: 3,
          plugin: plugin(),
          rawSourceText: JSON.stringify(payload),
          sourcePath: ".mcp.json",
        })
        throw new Error("expected declaration limit failure")
      } catch (error) {
        expectRouteFailure(error, "github_import_limit_exceeded")
      }
    }
  })

  test("uses bounded publisher names, safe opaque keys, and safe source paths", () => {
    const [server] = store.mcpServerEntriesFromPayload({
      plugin: plugin({ displayName: "p".repeat(4_096) }),
      rawSourceText: JSON.stringify({
        mcpServers: {
          ["s".repeat(4_096)]: { url: "https://mcp.example.test/mcp" },
        },
      }),
      sourcePath: ".mcp.json",
    })
    expect(server?.name.length).toBe(255)
    expect(server?.pluginName.length).toBe(255)
    expect(server?.serverKey).toMatch(/^github-mcp:[A-Za-z0-9_-]{43}$/)
    expect(server?.sourcePath).toBe(".mcp.json")

    expect(() => store.mcpServerEntriesFromPayload({
      plugin: plugin(),
      rawSourceText: JSON.stringify({ mcpServers: { one: { url: "https://mcp.example.test/mcp" } } }),
      sourcePath: "../secrets/.mcp.json",
    })).toThrow("safe repository path")
  })

  test("never reflects or accepts credential-bearing publisher URLs", () => {
    for (const parameter of [
      "cookie",
      "proxy_authorization",
      "signature",
      "credential",
      "X-Amz-Signature",
      "x-amz-credential",
      "session_token",
      "github_token",
      "proxy_password",
      "key",
    ]) {
      const [server] = store.mcpServerEntriesFromPayload({
        plugin: plugin(),
        rawSourceText: JSON.stringify({
          mcpServers: { one: { url: `https://mcp.example.test/mcp?${parameter}=publisher-secret` } },
        }),
        sourcePath: ".mcp.json",
      })
      expect(server).toMatchObject({ skippedReason: "invalid_url", supported: false, url: null })
      expect(JSON.stringify(server)).not.toContain("publisher-secret")
    }
  })
})
