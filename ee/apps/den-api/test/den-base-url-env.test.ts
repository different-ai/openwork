import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const denApiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function probeDenUrls(overrides: Record<string, string>) {
  const result = spawnSync(process.execPath, ["--conditions", "development", "--eval", `
    const { env } = await import("./src/env.ts")
    console.log(JSON.stringify({
      betterAuthUrl: env.betterAuthUrl,
      betterAuthCookieDomain: env.betterAuthCookieDomain ?? null,
      webUrl: env.webUrl,
      apiPublicUrl: env.apiPublicUrl,
      mcpResourceUrl: env.mcpResourceUrl,
      desktopDenBaseUrl: env.desktopDenBaseUrl,
      corsOrigins: env.corsOrigins,
      betterAuthTrustedOrigins: env.betterAuthTrustedOrigins,
      webAppHosts: env.webAppHosts,
    }))
  `], {
    cwd: denApiRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_test",
      DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "x".repeat(32),
      BETTER_AUTH_SECRET: "y".repeat(32),
      OPENWORK_DEV_MODE: "0",
      PROVISIONER_MODE: "stub",
      ...overrides,
    },
  })
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout) as Record<string, string | string[]>
}

describe("DEN_BASE_URL environment defaults", () => {
  test("derives Den API server URLs from the shared base", () => {
    expect(probeDenUrls({ DEN_BASE_URL: "https://den.example.com" })).toEqual({
      betterAuthUrl: "https://den.example.com",
      betterAuthCookieDomain: "den.example.com",
      webUrl: "https://den.example.com",
      apiPublicUrl: "https://api.den.example.com",
      mcpResourceUrl: "https://api.den.example.com/mcp",
      corsOrigins: ["https://den.example.com"],
      betterAuthTrustedOrigins: ["https://den.example.com"],
      webAppHosts: ["den.example.com"],
    })
  })

  test("derives local development API and MCP URLs from DEN_BASE_URL and PORT", () => {
    expect(probeDenUrls({
      DEN_BASE_URL: "http://localhost:3005",
      OPENWORK_DEV_MODE: "1",
      PORT: "8790",
    })).toEqual({
      betterAuthUrl: "http://localhost:3005",
      betterAuthCookieDomain: null,
      webUrl: "http://localhost:3005",
      apiPublicUrl: "http://127.0.0.1:8790",
      mcpResourceUrl: "http://127.0.0.1:8790/mcp",
      corsOrigins: ["http://localhost:3005"],
      betterAuthTrustedOrigins: ["http://localhost:3005"],
      webAppHosts: ["localhost"],
    })
  })

  test("deduplicates DEN_BASE_URL-derived origins with explicit origin lists", () => {
    expect(probeDenUrls({
      DEN_BASE_URL: "https://den.example.com",
      CORS_ORIGINS: "https://den.example.com,https://preview.example.com",
      DEN_BETTER_AUTH_TRUSTED_ORIGINS: "https://preview.example.com",
      DEN_WEB_APP_HOSTS: "den.example.com,.preview.example.com",
    })).toMatchObject({
      corsOrigins: ["https://den.example.com", "https://preview.example.com"],
      betterAuthTrustedOrigins: ["https://den.example.com", "https://preview.example.com"],
      webAppHosts: ["den.example.com", ".preview.example.com"],
    })
  })

  test("keeps explicit URL settings ahead of DEN_BASE_URL", () => {
    expect(probeDenUrls({
      DEN_BASE_URL: "https://den.example.com",
      BETTER_AUTH_URL: "https://web.explicit.test",
      DEN_API_PUBLIC_URL: "https://api.explicit.test/prefix",
      DEN_MCP_RESOURCE_URL: "https://mcp.explicit.test/resource",
      DEN_DESKTOP_DEN_BASE_URL: "https://desktop.explicit.test/api/den",
    })).toEqual({
      betterAuthUrl: "https://web.explicit.test",
      betterAuthCookieDomain: null,
      webUrl: "https://web.explicit.test",
      apiPublicUrl: "https://api.explicit.test/prefix",
      mcpResourceUrl: "https://mcp.explicit.test/resource",
      desktopDenBaseUrl: "https://desktop.explicit.test/api/den",
      corsOrigins: ["https://den.example.com", "https://web.explicit.test"],
      betterAuthTrustedOrigins: ["https://den.example.com", "https://web.explicit.test"],
      webAppHosts: ["den.example.com", "web.explicit.test"],
    })
  })

  test("supports explicit shared cookie domains for sibling web and API hosts", () => {
    expect(probeDenUrls({
      BETTER_AUTH_URL: "https://app.openworklabs.com",
      DEN_API_PUBLIC_URL: "https://api.openworklabs.com",
      DEN_BETTER_AUTH_COOKIE_DOMAIN: "openworklabs.com",
      CORS_ORIGINS: "https://app.openworklabs.com,https://api.openworklabs.com,https://api.app.openworklabs.com",
    })).toMatchObject({
      betterAuthUrl: "https://app.openworklabs.com",
      betterAuthCookieDomain: "openworklabs.com",
      webUrl: "https://app.openworklabs.com",
      apiPublicUrl: "https://api.openworklabs.com",
      corsOrigins: ["https://app.openworklabs.com", "https://api.openworklabs.com", "https://api.app.openworklabs.com"],
      betterAuthTrustedOrigins: ["https://app.openworklabs.com"],
      webAppHosts: ["app.openworklabs.com"],
    })
  })

  test("exposes only the public web origin when BETTER_AUTH_URL includes URL components", () => {
    expect(probeDenUrls({
      BETTER_AUTH_URL: "https://user:secret@legacy.example.com/auth/path?token=hidden#fragment",
    })).toEqual({
      betterAuthUrl: "https://user:secret@legacy.example.com/auth/path?token=hidden#fragment",
      betterAuthCookieDomain: "legacy.example.com",
      webUrl: "https://legacy.example.com",
      apiPublicUrl: "https://api.legacy.example.com",
      corsOrigins: ["https://legacy.example.com"],
      betterAuthTrustedOrigins: ["https://legacy.example.com"],
      webAppHosts: ["legacy.example.com"],
    })
  })

  test("derives the public API URL from BETTER_AUTH_URL without DEN_BASE_URL", () => {
    expect(probeDenUrls({ BETTER_AUTH_URL: "https://legacy.example.com" })).toEqual({
      betterAuthUrl: "https://legacy.example.com",
      betterAuthCookieDomain: "legacy.example.com",
      webUrl: "https://legacy.example.com",
      apiPublicUrl: "https://api.legacy.example.com",
      corsOrigins: ["https://legacy.example.com"],
      betterAuthTrustedOrigins: ["https://legacy.example.com"],
      webAppHosts: ["legacy.example.com"],
    })
  })

  test("derives local API URL from BETTER_AUTH_URL and PORT without DEN_BASE_URL", () => {
    expect(probeDenUrls({
      BETTER_AUTH_URL: "http://localhost:3005",
      OPENWORK_DEV_MODE: "1",
      PORT: "8790",
    })).toMatchObject({
      betterAuthUrl: "http://localhost:3005",
      betterAuthCookieDomain: null,
      webUrl: "http://localhost:3005",
      apiPublicUrl: "http://127.0.0.1:8790",
      corsOrigins: ["http://localhost:3005"],
      betterAuthTrustedOrigins: ["http://localhost:3005"],
      webAppHosts: ["localhost"],
    })
  })
})
