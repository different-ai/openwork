import { generateKeyPairSync } from "node:crypto";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { startMockGithub } from "@openwork/labs";
import type { MockGithubRepository } from "@openwork/labs";
import { localMysqlIsRunning, needs, server, test } from "@openwork/testkit";

/**
 * CLAIMS:
 *  - The GitHub repository picker returns all 130 installation repositories in
 *    provider order across its cursor pages, including private repositories.
 *  - Repository enumeration requests only GitHub pages 1 and 2 at 100 items per
 *    page, and repository traffic uses the installation token rather than the
 *    GitHub App JWT.
 *  - Discovery recognizes the private Claude marketplace repository, its one
 *    supported plugin, and its skill directory without warnings.
 *  - Applying that discovery succeeds and derives the imported skill title and
 *    description from intact YAML frontmatter.
 *  - A companion markdown file below the skill is not imported as another skill.
 *  - The stored skill source strictly equals the provider's full SKILL.md after
 *    product-wide surrounding-whitespace canonicalization, with frontmatter and
 *    body bytes intact.
 *  - Re-applying an unchanged revision reuses the same config object, creates no
 *    duplicate version, and does not fetch the skill file again.
 */

const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1"
  && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !localPlacement
  ? "github connector import skipped — needs: local placement without OPENWORK_EVAL_DEN_API_URL"
  : !mysqlOpen
    ? "github connector import skipped — needs: MySQL on 127.0.0.1:3306"
    : "the GitHub connector lists every installation repository and imports marketplace skills end-to-end";

const REQUEST_TIMEOUT_MS = 120_000;
const SKILL_MARKDOWN = "---\nname: probe\ndescription: Probe connector import\n---\n\nRun the probe checklist.\n";
const SKILL_PATH = "probe-plugin/skills/probe/SKILL.md";
const SKILL_CONTENT_REQUEST_PATH = `/repos/acme-eval/probe-plugins/contents/${SKILL_PATH}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value).slice(0, 500)}`);
  return value;
}

function requireRecords(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`${label} was not an object array: ${JSON.stringify(value).slice(0, 500)}`);
  }
  return value.filter(isRecord);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} was not a non-empty string.`);
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} was not a finite number.`);
  return value;
}

function responseItem(body: unknown, label: string): Record<string, unknown> {
  return requireRecord(requireRecord(body, `${label} response`).item, `${label} item`);
}

function installEnvironment(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function githubRepositories(): MockGithubRepository[] {
  return Array.from({ length: 130 }, (_, index) => {
    const id = index + 1;
    return id === 42
      ? { id, fullName: "acme-eval/probe-plugins", defaultBranch: "develop", private: true }
      : { id, fullName: `acme-eval/repo-${id}`, defaultBranch: "main", private: false };
  });
}

interface ApiResult {
  body: unknown;
  status: number;
  text: string;
}

async function apiRequest(
  session: DenSession,
  path: string,
  input: { body?: Record<string, unknown>; method?: "GET" | "POST"; orgId?: string } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${session.token}`,
  };
  if (input.orgId) headers["x-openwork-org-id"] = input.orgId;
  if (input.body) headers["content-type"] = "application/json";
  const result = await denFetch(session, path, {
    method: input.method ?? "GET",
    headers,
    body: input.body ? JSON.stringify(input.body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!result.response.ok) {
    throw new Error(`${input.method ?? "GET"} ${path} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return { body: result.body, status: result.response.status, text: result.text };
}

async function resolveOrganizationId(session: DenSession): Promise<string> {
  const result = await apiRequest(session, "/v1/me/orgs");
  const orgs = requireRecords(requireRecord(result.body, "organization list response").orgs, "organizations");
  expect(orgs).toHaveLength(1);
  return requireString(orgs[0]?.id, "organization id");
}

test.skipIf(!localPlacement || !mysqlOpen)(title, async ({ evidence, place }) => {
  needs({});
  const repositories = githubRepositories();
  const marketplaceManifest = JSON.stringify({
    name: "Probe marketplace",
    description: "Private GitHub connector marketplace fixture",
    owner: { name: "acme-eval" },
    plugins: [{
      name: "probe-plugin",
      description: "Probe connector plugin",
      source: "./probe-plugin",
    }],
  });
  const pluginManifest = JSON.stringify({
    name: "probe-plugin",
    description: "Probe connector plugin",
    skills: ["./skills"],
  });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = String(privateKey.export({ type: "pkcs8", format: "pem" }));

  await using github = await startMockGithub({
    installationId: 777,
    accountLogin: "acme-eval",
    repositories,
    repoFiles: {
      "acme-eval/probe-plugins": {
        branch: "develop",
        files: {
          ".claude-plugin/marketplace.json": marketplaceManifest,
          "probe-plugin/.claude-plugin/plugin.json": pluginManifest,
          [SKILL_PATH]: SKILL_MARKDOWN,
          "probe-plugin/skills/probe/references/notes.md": "# Notes\n\nCompanion file that must not be imported as a skill.\n",
        },
      },
    },
  });
  const restoreEnvironment = installEnvironment({
    GITHUB_CONNECTOR_API_BASE: github.apiUrl,
    GITHUB_CONNECTOR_APP_ID: "123456",
    GITHUB_CONNECTOR_APP_PRIVATE_KEY: privateKeyPem,
  });

  try {
    await using den = await server({ place });
    const orgId = await resolveOrganizationId(den.admin);
    const selectedOrganization = await apiRequest(den.admin, "/v1/me/active-organization", {
      method: "POST",
      orgId,
      body: { organizationId: orgId },
    });
    expect(selectedOrganization.status).toBe(200);

    const accountResult = await apiRequest(den.admin, "/v1/connectors/github/accounts", {
      method: "POST",
      orgId,
      body: {
        installationId: 777,
        accountLogin: "acme-eval",
        accountType: "Organization",
        displayName: "acme-eval",
      },
    });
    expect(accountResult.status).toBe(201);
    const connectorAccountId = requireString(responseItem(accountResult.body, "GitHub account").id, "connector account id");

    const repositoryListStartedAt = new Date().toISOString();
    const firstRepositoryPage = await apiRequest(
      den.admin,
      `/v1/connectors/github/accounts/${encodeURIComponent(connectorAccountId)}/repositories?limit=100`,
      { orgId },
    );
    const firstRepositoryBody = requireRecord(firstRepositoryPage.body, "first repository page");
    const firstRepositories = requireRecords(firstRepositoryBody.items, "first repository page items");
    const nextCursor = requireString(firstRepositoryBody.nextCursor, "first repository page next cursor");
    expect(firstRepositories).toHaveLength(100);

    const secondRepositoryPage = await apiRequest(
      den.admin,
      `/v1/connectors/github/accounts/${encodeURIComponent(connectorAccountId)}/repositories?limit=100&cursor=${encodeURIComponent(nextCursor)}`,
      { orgId },
    );
    const secondRepositoryBody = requireRecord(secondRepositoryPage.body, "second repository page");
    const secondRepositories = requireRecords(secondRepositoryBody.items, "second repository page items");
    expect(secondRepositories).toHaveLength(30);
    expect(secondRepositoryBody.nextCursor).toBeNull();

    const listedRepositories = [...firstRepositories, ...secondRepositories];
    const repositoryIds = listedRepositories.map((repository) => requireNumber(repository.id, "repository id"));
    const orderedIds = Array.from({ length: 130 }, (_, index) => index + 1);
    const repositoriesCompleteAndOrdered = new Set(repositoryIds).size === 130
      && repositoryIds.every((id, index) => id === orderedIds[index]);
    expect(repositoryIds).toEqual(orderedIds);
    expect(new Set(repositoryIds).size).toBe(130);
    const marketplaceRepository = listedRepositories.find((repository) => repository.id === 42);
    expect(marketplaceRepository).toMatchObject({
      fullName: "acme-eval/probe-plugins",
      private: true,
      hasPluginManifest: true,
      manifestKind: "marketplace",
    });
    evidence.fact(
      "The repository picker returns all 130 installation repositories across cursor pages",
      `The first page contained ${firstRepositories.length}, the second contained ${secondRepositories.length}, and the concatenated IDs were ${repositoryIds[0]} through ${repositoryIds.at(-1)} in provider order (regression: only the first 30 before #3524).`,
      repositoriesCompleteAndOrdered,
    );

    const pickerRequests = (await github.requests()).filter((request) => request.at >= repositoryListStartedAt);
    const installationRepositoryRequests = pickerRequests.filter((request) => request.path === "/installation/repositories");
    const providerPages = installationRepositoryRequests.map((request) => {
      const url = new URL(request.url, github.apiUrl);
      return {
        page: url.searchParams.get("page"),
        perPage: url.searchParams.get("per_page"),
      };
    });
    const uniqueProviderPages = [...new Set(providerPages.map((request) => request.page))];
    const providerPaginationCorrect = providerPages.length >= 2
      && providerPages.every((request) => request.perPage === "100" && (request.page === "1" || request.page === "2"))
      && uniqueProviderPages.length === 2
      && uniqueProviderPages[0] === "1"
      && uniqueProviderPages[1] === "2";
    expect(uniqueProviderPages).toEqual(["1", "2"]);
    expect(providerPages.every((request) => request.perPage === "100")).toBe(true);
    evidence.fact(
      "GitHub repository enumeration requests provider pages 1 and 2 at 100 items per page",
      `Provider pagination requests were ${JSON.stringify(providerPages)}; there was no unpaged request or page 3 request.`,
      providerPaginationCorrect,
    );

    const repositoryProviderRequests = pickerRequests.filter((request) => (
      request.path === "/installation/repositories" || request.path.startsWith("/repos/")
    ));
    const installationToken = "Bearer mock-installation-token-777";
    const installationTokenIdentityCorrect = repositoryProviderRequests.length > 0
      && repositoryProviderRequests.every((request) => request.authorization === installationToken);
    expect(repositoryProviderRequests.length).toBeGreaterThan(0);
    expect([...new Set(repositoryProviderRequests.map((request) => request.authorization))]).toEqual([installationToken]);
    evidence.fact(
      "Repository discovery uses the GitHub installation access token",
      `${repositoryProviderRequests.length} repository and content requests carried ${installationToken}, not the app JWT.`,
      installationTokenIdentityCorrect,
    );

    const setupResult = await apiRequest(den.admin, "/v1/connectors/github/setup", {
      method: "POST",
      orgId,
      body: {
        installationId: 777,
        connectorAccountId,
        connectorInstanceName: "Probe plugins",
        repositoryId: 42,
        repositoryFullName: "acme-eval/probe-plugins",
        branch: "develop",
        ref: "refs/heads/develop",
        mappings: [],
      },
    });
    expect([200, 201]).toContain(setupResult.status);
    const setupItem = responseItem(setupResult.body, "GitHub setup");
    const connectorInstanceId = requireString(
      requireRecord(setupItem.connectorInstance, "setup connector instance").id,
      "connector instance id",
    );

    const discoveryResult = await apiRequest(
      den.admin,
      `/v1/connector-instances/${encodeURIComponent(connectorInstanceId)}/discovery`,
      { orgId },
    );
    const discoveryItem = responseItem(discoveryResult.body, "GitHub discovery");
    const discoveredPlugins = requireRecords(discoveryItem.discoveredPlugins, "discovered plugins");
    expect(discoveryItem.classification).toBe("claude_marketplace_repo");
    expect(discoveredPlugins).toHaveLength(1);
    const discoveredPlugin = discoveredPlugins[0];
    expect(discoveredPlugin).toMatchObject({ supported: true, warnings: [] });
    expect(requireRecord(discoveredPlugin?.componentPaths, "discovered plugin component paths").skills).toEqual([
      "probe-plugin/skills",
    ]);
    expect(discoveryItem.warnings).toEqual([]);
    const discoverySupportedWithoutWarnings = discoveryItem.classification === "claude_marketplace_repo"
      && discoveredPlugins.length === 1
      && discoveredPlugin?.supported === true
      && Array.isArray(discoveredPlugin.warnings)
      && discoveredPlugin.warnings.length === 0
      && Array.isArray(discoveryItem.warnings)
      && discoveryItem.warnings.length === 0;
    evidence.fact(
      "Discovery classifies the private marketplace repository with one supported plugin and no warnings",
      `Classification was ${String(discoveryItem.classification)}; plugin support was ${String(discoveredPlugin?.supported)}; discovery and plugin warnings were empty.`,
      discoverySupportedWithoutWarnings,
    );

    const selectedKey = requireString(discoveredPlugin?.key, "discovered plugin key");
    const applyBody = { autoImportNewPlugins: false, selectedKeys: [selectedKey] };
    const applyStartedAt = new Date().toISOString();
    const firstApplyResult = await apiRequest(
      den.admin,
      `/v1/connector-instances/${encodeURIComponent(connectorInstanceId)}/discovery/apply`,
      { method: "POST", orgId, body: applyBody },
    );
    expect(firstApplyResult.status).toBe(200);
    expect(requireRecord(firstApplyResult.body, "first apply response").ok).toBe(true);
    const firstApplyItem = responseItem(firstApplyResult.body, "first discovery apply");
    requireRecord(firstApplyItem.createdMarketplace, "created marketplace");
    expect(requireRecords(firstApplyItem.createdPlugins, "created plugins")).toHaveLength(1);
    const firstMaterializedObjects = requireRecords(firstApplyItem.materializedConfigObjects, "materialized config objects");
    expect(firstMaterializedObjects).toHaveLength(1);
    const materializedSkill = firstMaterializedObjects[0];
    expect(materializedSkill).toMatchObject({
      objectType: "skill",
      title: "probe",
      description: "Probe connector import",
      currentRelativePath: SKILL_PATH,
    });
    const configObjectId = requireString(materializedSkill?.id, "materialized config object id");
    const frontmatterProjectionCorrect = materializedSkill?.objectType === "skill"
      && materializedSkill.title === "probe"
      && materializedSkill.description === "Probe connector import"
      && materializedSkill.currentRelativePath === SKILL_PATH;
    evidence.fact(
      "Applying the marketplace import materializes the frontmatter-derived probe skill",
      `Apply returned HTTP ${firstApplyResult.status}; the only materialized object was ${String(materializedSkill?.currentRelativePath)} titled ${String(materializedSkill?.title)} (regression: invalid_skill_frontmatter before #3523).`,
      firstApplyResult.status === 200 && frontmatterProjectionCorrect,
    );
    evidence.fact(
      "The companion markdown next to the skill is not imported",
      `The repository tree included references/notes.md, while apply materialized ${firstMaterializedObjects.length} config object at ${String(materializedSkill?.currentRelativePath)}.`,
      firstMaterializedObjects.length === 1 && materializedSkill?.currentRelativePath === SKILL_PATH,
    );

    const firstVersionsResult = await apiRequest(
      den.admin,
      `/v1/config-objects/${encodeURIComponent(configObjectId)}/versions`,
      { orgId },
    );
    const firstVersions = requireRecords(requireRecord(firstVersionsResult.body, "first version list").items, "first versions");
    expect(firstVersions).toHaveLength(1);
    const storedSource = requireString(firstVersions[0]?.rawSourceText, "stored skill source");
    expect(storedSource).toBe(SKILL_MARKDOWN.trim());
    expect(storedSource.startsWith("---\nname: probe\ndescription: Probe connector import\n---")).toBe(true);
    expect(storedSource.endsWith("Run the probe checklist.")).toBe(true);
    const sourceMatchesCanonicalForm = storedSource === SKILL_MARKDOWN.trim();
    evidence.fact(
      "The imported SKILL.md keeps frontmatter and body byte-for-byte after canonical whitespace trimming",
      "The stored version strictly equaled the provider source after surrounding-whitespace canonicalization; normalizeOptionalString trims every config-object version, including manual creates.",
      firstVersions.length === 1 && sourceMatchesCanonicalForm,
    );

    const secondApplyResult = await apiRequest(
      den.admin,
      `/v1/connector-instances/${encodeURIComponent(connectorInstanceId)}/discovery/apply`,
      { method: "POST", orgId, body: applyBody },
    );
    expect(secondApplyResult.status).toBe(200);
    expect(requireRecord(secondApplyResult.body, "second apply response").ok).toBe(true);
    const secondApplyItem = responseItem(secondApplyResult.body, "second discovery apply");
    const secondMaterializedObjects = requireRecords(secondApplyItem.materializedConfigObjects, "second materialized config objects");
    expect(secondMaterializedObjects).toHaveLength(1);
    expect(secondMaterializedObjects[0]?.id).toBe(configObjectId);

    const secondVersionsResult = await apiRequest(
      den.admin,
      `/v1/config-objects/${encodeURIComponent(configObjectId)}/versions`,
      { orgId },
    );
    const secondVersions = requireRecords(requireRecord(secondVersionsResult.body, "second version list").items, "second versions");
    expect(secondVersions).toHaveLength(1);
    expect(secondVersions[0]?.rawSourceText).toBe(SKILL_MARKDOWN.trim());
    const skillContentRequests = (await github.requests()).filter((request) => (
      request.at >= applyStartedAt
      && request.method === "GET"
      && request.path === SKILL_CONTENT_REQUEST_PATH
    ));
    expect(skillContentRequests).toHaveLength(1);
    const reapplyIsIdempotent = secondMaterializedObjects.length === 1
      && secondMaterializedObjects[0]?.id === configObjectId
      && secondVersions.length === 1
      && skillContentRequests.length === 1;
    evidence.fact(
      "Re-applying the same revision creates no duplicate version and refetches no file content",
      `Both applies returned config object ${configObjectId}; versions remained ${secondVersions.length}; ${SKILL_PATH} was fetched ${skillContentRequests.length} time since ${applyStartedAt}.`,
      reapplyIsIdempotent,
    );
  } finally {
    restoreEnvironment();
  }
});
