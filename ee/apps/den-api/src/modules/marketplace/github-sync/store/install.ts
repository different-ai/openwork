import { and, eq } from "@openwork-ee/den-db/drizzle"
import { ConnectorAccountTable } from "@openwork-ee/den-db/schema"
import type { PluginArchActorContext } from "../../../../routes/org/plugin-system/access.js"
import {
  buildGithubAppInstallUrl,
  createGithubInstallStateToken,
  getGithubAppSummary,
  getGithubInstallationAccessToken,
  getGithubInstallationSummary,
  listGithubInstallationRepositories,
  validateGithubInstallationTarget,
  verifyGithubInstallStateToken,
} from "../../../../routes/org/plugin-system/github-app.js"
import { db } from "../../../../db.js"
import { env } from "../../../../env.js"
import { PluginArchRouteFailure } from "../../store/route-failure.js"
import { type ConnectorAccountId, type ConnectorMappingRow, pageItems, type PluginId } from "../../store/internal.js"
import { getConnectorAccountRow, githubConnectorAppConfig, wrapGithubConnectorError } from "./shared.js"
import {
  createConnectorAccount,
  createConnectorInstance,
  createConnectorMapping,
  createConnectorTarget,
  getConnectorAccountDetail,
} from "./connectors.js"
import { computeGithubDiscoverySnapshot, withGithubDiscoveryCache } from "./discovery.js"

type RepositorySummary = {
  defaultBranch: string | null
  fullName: string
  hasPluginManifest?: boolean
  id: number
  manifestKind?: "agent-plugin" | "marketplace" | "plugin" | null
  marketplacePluginCount?: number | null
  private: boolean
}

export function consumeGithubInstallState(state: string) {
  const parsed = verifyGithubInstallStateToken({ secret: env.betterAuthSecret, token: state })
  if (!parsed) {
    throw new PluginArchRouteFailure(400, "invalid_github_install_state", "GitHub install state is invalid or expired.")
  }
  return parsed
}

export async function createGithubConnectorAccount(input: { accountLogin: string; accountType: "Organization" | "User"; context: PluginArchActorContext; displayName: string; installationId: number }) {
  return createConnectorAccount({
    connectorType: "github",
    context: input.context,
    displayName: input.displayName,
    metadata: {
      accountLogin: input.accountLogin,
      accountType: input.accountType,
      repositories: [],
      repositorySelection: "all",
      settingsUrl: null,
    },
    remoteId: String(input.installationId),
  })
}

async function upsertGithubConnectorAccountFromInstallation(input: { context: PluginArchActorContext; installationId: number }) {
  let installation: Awaited<ReturnType<typeof getGithubInstallationSummary>>
  try {
    installation = await getGithubInstallationSummary({
      config: githubConnectorAppConfig(),
      installationId: input.installationId,
    })
  } catch (error) {
    wrapGithubConnectorError(error)
  }
  const organizationId = input.context.organizationContext.organization.id
  const existingRows = await db
    .select()
    .from(ConnectorAccountTable)
    .where(and(
      eq(ConnectorAccountTable.organizationId, organizationId),
      eq(ConnectorAccountTable.connectorType, "github"),
      eq(ConnectorAccountTable.remoteId, String(input.installationId)),
    ))
    .limit(1)

  const metadata = {
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    repositories: [],
    repositorySelection: installation.repositorySelection,
    settingsUrl: installation.settingsUrl,
  }

  if (!existingRows[0]) {
    return createConnectorAccount({
      connectorType: "github",
      context: input.context,
      displayName: installation.displayName,
      externalAccountRef: installation.accountLogin,
      metadata,
      remoteId: String(input.installationId),
    })
  }

  await db.update(ConnectorAccountTable).set({
    displayName: installation.displayName,
    externalAccountRef: installation.accountLogin,
    metadataJson: {
      ...(existingRows[0].metadataJson ?? {}),
      ...metadata,
    },
    status: "active",
    updatedAt: new Date(),
  }).where(eq(ConnectorAccountTable.id, existingRows[0].id))

  return getConnectorAccountDetail(input.context, existingRows[0].id)
}

export async function startGithubConnectorInstall(input: { context: PluginArchActorContext; returnPath: string }) {
  const returnPath = input.returnPath.trim()
  if (!returnPath.startsWith("/") || returnPath.startsWith("//")) {
    throw new PluginArchRouteFailure(400, "invalid_return_path", "GitHub install return path must be a safe relative path.")
  }

  let app: Awaited<ReturnType<typeof getGithubAppSummary>>
  try {
    app = await getGithubAppSummary({ config: githubConnectorAppConfig() })
  } catch (error) {
    wrapGithubConnectorError(error)
  }
  const state = createGithubInstallStateToken({
    orgId: input.context.organizationContext.organization.id,
    returnPath,
    secret: env.betterAuthSecret,
    userId: input.context.organizationContext.currentMember.userId,
  })

  return {
    redirectUrl: buildGithubAppInstallUrl({ app, state }),
    state,
  }
}

export async function completeGithubConnectorInstall(input: { context: PluginArchActorContext; installationId: number; state: string }) {
  const parsedState = consumeGithubInstallState(input.state)
  if (parsedState.orgId !== input.context.organizationContext.organization.id) {
    throw new PluginArchRouteFailure(409, "github_install_org_mismatch", "GitHub install state does not match the current organization.")
  }
  if (parsedState.userId !== input.context.organizationContext.currentMember.userId) {
    throw new PluginArchRouteFailure(409, "github_install_user_mismatch", "GitHub install state does not match the current user.")
  }

  const connectorAccount = await upsertGithubConnectorAccountFromInstallation({
    context: input.context,
    installationId: input.installationId,
  })

  return {
    connectorAccount,
    // Keep install completion fast. The connected-account screen loads repositories next.
    repositories: [],
  }
}

export async function listGithubRepositories(input: { connectorAccountId: ConnectorAccountId; context: PluginArchActorContext; cursor?: string; limit?: number; q?: string }) {
  const account = await getConnectorAccountRow(input.context.organizationContext.organization.id, input.connectorAccountId)
  if (!account) {
    throw new PluginArchRouteFailure(404, "connector_account_not_found", "Connector account not found.")
  }
  if (account.connectorType !== "github") {
    throw new PluginArchRouteFailure(409, "github_connector_account_required", "Connector account is not a GitHub account.")
  }

  const installationId = Number(account.remoteId)
  if (!Number.isFinite(installationId) || installationId <= 0) {
    throw new PluginArchRouteFailure(409, "invalid_github_installation_id", "Connector account does not have a valid GitHub installation id.")
  }

  let repositories: RepositorySummary[]
  let installationSummary: Awaited<ReturnType<typeof getGithubInstallationSummary>>
  try {
    repositories = await listGithubInstallationRepositories({
      config: githubConnectorAppConfig(),
      installationId,
    })
    installationSummary = await getGithubInstallationSummary({
      config: githubConnectorAppConfig(),
      installationId,
    })
  } catch (error) {
    wrapGithubConnectorError(error)
  }

  const existingMetadata = account.metadataJson && typeof account.metadataJson === "object"
    ? account.metadataJson as Record<string, unknown>
    : {}
  await db.update(ConnectorAccountTable).set({
    metadataJson: {
      ...existingMetadata,
      repositories: repositories.map((repository) => ({
        defaultBranch: repository.defaultBranch,
        fullName: repository.fullName,
        hasPluginManifest: repository.hasPluginManifest ?? false,
        id: repository.id,
        manifestKind: repository.manifestKind ?? null,
        marketplacePluginCount: repository.marketplacePluginCount ?? null,
        private: repository.private,
      })),
      repositorySelection: installationSummary.repositorySelection,
      settingsUrl: installationSummary.settingsUrl,
    },
    updatedAt: new Date(),
  }).where(eq(ConnectorAccountTable.id, account.id))

  const filtered = repositories
    .filter((repository) => !input.q || `${repository.fullName}\n${repository.defaultBranch ?? ""}`.toLowerCase().includes(input.q.toLowerCase()))
    .map((repository) => ({ ...repository, id: String(repository.id) }))
  const page = pageItems(filtered, input.cursor, input.limit)
  return {
    items: page.items.map((repository) => ({
      defaultBranch: repository.defaultBranch,
      fullName: repository.fullName,
      hasPluginManifest: Boolean(repository.hasPluginManifest),
      id: Number(repository.id),
      manifestKind: repository.manifestKind ?? null,
      marketplacePluginCount: repository.marketplacePluginCount ?? null,
      private: repository.private,
    })),
    nextCursor: page.nextCursor,
  }
}

export async function validateGithubTarget(input: {
  branch: string
  config?: ReturnType<typeof githubConnectorAppConfig>
  installationId: number
  ref: string
  repositoryFullName: string
  repositoryId: number
  token?: string
}) {
  try {
    return await validateGithubInstallationTarget({
      branch: input.branch,
      config: input.config ?? githubConnectorAppConfig(),
      installationId: input.installationId,
      ref: input.ref,
      repositoryFullName: input.repositoryFullName,
      repositoryId: input.repositoryId,
      token: input.token,
    })
  } catch (error) {
    wrapGithubConnectorError(error)
  }
}

export async function githubSetup(input: {
  branch: string
  connectorAccountId?: ConnectorAccountId
  connectorInstanceName: string
  context: PluginArchActorContext
  installationId: number
  mappings: Array<{ autoAddToPlugin: boolean; config?: Record<string, unknown>; mappingKind: ConnectorMappingRow["mappingKind"]; objectType: ConnectorMappingRow["objectType"]; pluginId?: PluginId | null; selector: string }>
  ref: string
  repositoryFullName: string
  repositoryId: number
}) {
  const githubConfig = githubConnectorAppConfig()
  const installationToken = await getGithubInstallationAccessToken({
    config: githubConfig,
    installationId: input.installationId,
  })
  const validation = await validateGithubTarget({
    branch: input.branch,
    config: githubConfig,
    installationId: input.installationId,
    ref: input.ref,
    repositoryFullName: input.repositoryFullName,
    repositoryId: input.repositoryId,
    token: installationToken,
  })
  if (!validation.repositoryAccessible) {
    throw new PluginArchRouteFailure(409, "github_repository_not_accessible", "GitHub repository is not accessible for this installation.")
  }
  if (!validation.branchExists) {
    throw new PluginArchRouteFailure(409, "github_branch_not_found", "GitHub branch/ref could not be validated for this repository.")
  }

  const discovery = await computeGithubDiscoverySnapshot({
    branch: input.branch,
    installationId: input.installationId,
    ref: input.ref,
    repositoryFullName: input.repositoryFullName,
    token: installationToken,
  })

  let connectorAccountId = input.connectorAccountId as ConnectorAccountId | undefined
  let connectorAccountDetail = connectorAccountId ? await getConnectorAccountDetail(input.context, connectorAccountId) : null
  if (!connectorAccountId || !connectorAccountDetail) {
    connectorAccountDetail = await createGithubConnectorAccount({
      accountLogin: input.repositoryFullName.split("/")[0] ?? input.repositoryFullName,
      accountType: "Organization",
      context: input.context,
      displayName: input.repositoryFullName,
      installationId: input.installationId,
    })
    connectorAccountId = connectorAccountDetail.id
  }

  const connectorInstance = await createConnectorInstance({
    connectorAccountId,
    connectorType: "github",
    config: {
      autoImportNewPlugins: true,
      installationId: input.installationId,
    },
    context: input.context,
    name: input.connectorInstanceName,
    remoteId: input.repositoryFullName,
  })

  const connectorTarget = await createConnectorTarget({
    config: withGithubDiscoveryCache({
      branch: input.branch,
      defaultBranch: validation.defaultBranch,
      ref: input.ref,
      repositoryFullName: input.repositoryFullName,
      repositoryId: input.repositoryId,
    }, {
      branch: discovery.branch,
      classification: discovery.classification,
      discoveredPlugins: discovery.discoveredPlugins,
      importPlansByPluginKey: discovery.importPlansByPluginKey,
      marketplace: discovery.marketplace,
      ref: discovery.ref,
      repositoryFullName: discovery.repositoryFullName,
      sourceRevisionRef: discovery.sourceRevisionRef,
      treeSummary: discovery.treeSummary,
      warnings: discovery.warnings,
    }),
    connectorInstanceId: connectorInstance.id,
    connectorType: "github",
    context: input.context,
    externalTargetRef: input.branch,
    remoteId: input.repositoryFullName,
    targetKind: "repository_branch",
  })

  for (const mapping of input.mappings) {
    await createConnectorMapping({
      autoAddToPlugin: mapping.autoAddToPlugin,
      config: mapping.config,
      connectorTargetId: connectorTarget.id,
      context: input.context,
      mappingKind: mapping.mappingKind,
      objectType: mapping.objectType,
      pluginId: mapping.pluginId,
      selector: mapping.selector,
    })
  }

  return {
    connectorAccount: connectorAccountDetail,
    connectorInstance,
    connectorTarget,
  }
}
