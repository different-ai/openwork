import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import {
  buildGithubAppInstallUrl,
  createGithubInstallStateToken,
  createGithubAppJwt,
  getGithubAppSummary,
  getGithubConnectorAppConfig,
  getGithubInstallationSummary,
  listGithubInstallationRepositories,
  normalizeGithubPrivateKey,
  validateGithubInstallationTarget,
  verifyGithubInstallStateToken,
} from "../src/routes/org/plugin-system/github-app.js"

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString()

describe("github connector app helpers", () => {
  test("normalizes escaped private keys and produces a signed app JWT", () => {
    const escapedKey = privateKeyPem.replace(/\n/g, "\\n")
    expect(normalizeGithubPrivateKey(escapedKey)).toBe(privateKeyPem)

    const config = getGithubConnectorAppConfig({
      appId: "123456",
      privateKey: escapedKey,
    })
    const jwt = createGithubAppJwt({ ...config, now: new Date("2026-04-21T19:00:00.000Z") })
    const [headerSegment, payloadSegment, signatureSegment] = jwt.split(".")

    expect(signatureSegment.length).toBeGreaterThan(0)
    expect(JSON.parse(Buffer.from(headerSegment, "base64url").toString("utf8"))).toEqual({ alg: "RS256", typ: "JWT" })
    expect(JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"))).toMatchObject({
      iss: "123456",
    })
  })

  test("lists repositories through the GitHub installation token flow", async () => {
    const requests: Array<{ method: string; url: string }> = []
    const repositories = await listGithubInstallationRepositories({
      config: { appId: "123456", privateKey: privateKeyPem },
      fetchFn: async (url, init) => {
        requests.push({
          method: init?.method ?? "GET",
          url: String(url),
        })

        if (String(url).endsWith("/access_tokens")) {
          return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 })
        }

        if (String(url).endsWith("/contents/.claude-plugin/marketplace.json")) {
          if (String(url).includes("different-ai/openwork")) {
            const content = Buffer.from(JSON.stringify({ plugins: [{ name: "a" }, { name: "b" }, { name: "c" }] })).toString("base64")
            return new Response(JSON.stringify({ content, encoding: "base64" }), { status: 200 })
          }
          return new Response(JSON.stringify({ message: "not found" }), { status: 404 })
        }

        if (String(url).endsWith("/contents/.claude-plugin/plugin.json")) {
          if (String(url).includes("different-ai/opencode")) {
            return new Response(JSON.stringify({ name: "plugin.json" }), { status: 200 })
          }
          return new Response(JSON.stringify({ message: "not found" }), { status: 404 })
        }

        return new Response(JSON.stringify({
          repositories: [
            { default_branch: "main", full_name: "different-ai/openwork", id: 42, private: true },
            { default_branch: "dev", full_name: "different-ai/opencode", id: 99, private: false },
          ],
        }), { status: 200 })
      },
      installationId: 777,
    })

    expect(requests.map((request) => request.url)).toEqual([
      "https://api.github.com/app/installations/777/access_tokens",
      "https://api.github.com/installation/repositories",
      "https://api.github.com/repos/different-ai/openwork/contents/.claude-plugin/marketplace.json",
      "https://api.github.com/repos/different-ai/opencode/contents/.claude-plugin/marketplace.json",
      "https://api.github.com/repos/different-ai/opencode/contents/.claude-plugin/plugin.json",
    ])
    expect(repositories).toEqual([
      { defaultBranch: "main", fullName: "different-ai/openwork", hasPluginManifest: true, id: 42, manifestKind: "marketplace", marketplacePluginCount: 3, private: true },
      { defaultBranch: "dev", fullName: "different-ai/opencode", hasPluginManifest: true, id: 99, manifestKind: "plugin", marketplacePluginCount: null, private: false },
    ])
  })

  test("builds install URLs and validates signed state tokens", async () => {
    const app = await getGithubAppSummary({
      config: { appId: "123456", privateKey: privateKeyPem },
      fetchFn: async () => new Response(JSON.stringify({
        html_url: "https://github.com/apps/openwork-test",
        name: "OpenWork Test",
        slug: "openwork-test",
      }), { status: 200 }),
    })

    const token = createGithubInstallStateToken({
      now: new Date("2026-04-21T19:00:00.000Z"),
      orgId: "org_123",
      returnPath: "/o/test-org/dashboard/integrations/github",
      secret: "secret-123",
      userId: "user_123",
    })

    expect(buildGithubAppInstallUrl({ app, state: token })).toBe(`https://github.com/apps/openwork-test/installations/new?state=${encodeURIComponent(token)}`)
    expect(verifyGithubInstallStateToken({ now: new Date("2026-04-21T19:05:00.000Z"), secret: "secret-123", token })).toMatchObject({
      orgId: "org_123",
      returnPath: "/o/test-org/dashboard/integrations/github",
      userId: "user_123",
    })
    expect(verifyGithubInstallStateToken({ now: new Date("2026-04-21T19:05:00.000Z"), secret: "wrong-secret", token })).toBeNull()
  })

  test("reads GitHub installation account details", async () => {
    const installation = await getGithubInstallationSummary({
      config: { appId: "123456", privateKey: privateKeyPem },
      fetchFn: async (url) => {
        if (String(url).endsWith("/app/installations/777")) {
          return new Response(JSON.stringify({
            account: {
              login: "different-ai",
              type: "Organization",
            },
            id: 777,
          }), { status: 200 })
        }
        return new Response(JSON.stringify({ message: "not found" }), { status: 404 })
      },
      installationId: 777,
    })

    expect(installation).toEqual({
      accountLogin: "different-ai",
      accountType: "Organization",
      displayName: "different-ai",
      installationId: 777,
      repositorySelection: "all",
      settingsUrl: null,
    })
  })

  test("validates repository identity and branch existence against GitHub", async () => {
    const result = await validateGithubInstallationTarget({
      branch: "main",
      config: { appId: "123456", privateKey: privateKeyPem },
      fetchFn: async (url) => {
        if (String(url).endsWith("/access_tokens")) {
          return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 })
        }

        if (String(url).endsWith("/repos/different-ai/openwork")) {
          return new Response(JSON.stringify({
            default_branch: "main",
            full_name: "different-ai/openwork",
            id: 42,
          }), { status: 200 })
        }

        if (String(url).endsWith("/repos/different-ai/openwork/branches/main")) {
          return new Response(JSON.stringify({ name: "main" }), { status: 200 })
        }

        return new Response(JSON.stringify({ message: "not found" }), { status: 404 })
      },
      installationId: 777,
      ref: "refs/heads/main",
      repositoryFullName: "different-ai/openwork",
      repositoryId: 42,
    })

    expect(result).toEqual({
      branchExists: true,
      defaultBranch: "main",
      repositoryAccessible: true,
    })
  })
})
