type GithubDiscoveryTreeEntryKind = "blob" | "tree"

export type GithubDiscoveryTreeEntry = {
  id: string
  kind: GithubDiscoveryTreeEntryKind
  path: string
  sha: string | null
  size: number | null
}

export type GithubDiscoveryClassification =
  | "claude_marketplace_repo"
  | "claude_multi_plugin_repo"
  | "claude_single_plugin_repo"
  | "folder_inferred_repo"
  | "unsupported"

export type GithubDiscoveredPluginSourceKind =
  | "marketplace_entry"
  | "plugin_manifest"
  | "standalone_claude"
  | "folder_inference"

export type GithubDiscoveredPluginComponentKind =
  | "skill"
  | "command"
  | "agent"
  | "hook"
  | "mcp_server"
  | "lsp_server"
  | "monitor"
  | "settings"

export type GithubDiscoveredPlugin = {
  componentKinds: GithubDiscoveredPluginComponentKind[]
  componentPaths: {
    agents: string[]
    commands: string[]
    hooks: string[]
    lspServers: string[]
    mcpServers: string[]
    monitors: string[]
    settings: string[]
    skills: string[]
  }
  description: string | null
  displayName: string
  key: string
  manifestPath: string | null
  metadata: Record<string, unknown>
  rootPath: string
  selectedByDefault: boolean
  sourceKind: GithubDiscoveredPluginSourceKind
  supported: boolean
  warnings: string[]
}

export type GithubMarketplaceInfo = {
  description: string | null
  name: string | null
  owner: string | null
  version: string | null
}

export type GithubRepoDiscoveryResult = {
  classification: GithubDiscoveryClassification
  discoveredPlugins: GithubDiscoveredPlugin[]
  marketplace: GithubMarketplaceInfo | null
  warnings: string[]
}

type MarketplaceEntry = {
  agents?: unknown
  commands?: unknown
  description?: unknown
  hooks?: unknown
  mcpServers?: unknown
  name?: unknown
  settings?: unknown
  skills?: unknown
  source?: unknown
}

type PluginMetadata = {
  description: string | null
  metadata: Record<string, unknown>
  name: string | null
}

const KNOWN_COMPONENT_SEGMENTS = ["skills", "commands", "agents"] as const

function normalizePath(value: string) {
  return value.trim().replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "")
}

function joinPath(rootPath: string, childPath: string) {
  const root = normalizePath(rootPath)
  const child = normalizePath(childPath)
  if (!root) return child
  if (!child) return root
  return `${root}/${child}`
}

function basename(path: string) {
  const normalized = normalizePath(path)
  if (!normalized) return null
  const parts = normalized.split("/")
  return parts[parts.length - 1] ?? null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function pathDirectoryPrefixes(path: string) {
  const segments = normalizePath(path).split("/").filter(Boolean)
  const prefixes: string[] = []
  for (let index = 1; index <= segments.length; index += 1) {
    prefixes.push(segments.slice(0, index).join("/"))
  }
  return prefixes
}

function buildPathSet(entries: GithubDiscoveryTreeEntry[]) {
  const knownPaths = new Set<string>()
  for (const entry of entries) {
    const normalizedPath = normalizePath(entry.path)
    if (!normalizedPath) continue
    knownPaths.add(normalizedPath)
    for (const prefix of pathDirectoryPrefixes(normalizedPath)) {
      knownPaths.add(prefix)
    }
  }
  return knownPaths
}

function hasPath(knownPaths: Set<string>, path: string) {
  const normalized = normalizePath(path)
  return normalized.length > 0 && knownPaths.has(normalized)
}

function hasDescendant(knownPaths: Set<string>, path: string) {
  const normalized = normalizePath(path)
  if (!normalized) return false
  for (const candidate of knownPaths) {
    if (candidate === normalized || candidate.startsWith(`${normalized}/`)) {
      return true
    }
  }
  return false
}

function readJsonMap(fileTextByPath: Record<string, string | null | undefined>, path: string) {
  const text = fileTextByPath[normalizePath(path)]
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function readPluginMetadata(fileTextByPath: Record<string, string | null | undefined>, rootPath: string, manifestPath?: string | null): PluginMetadata {
  const manifestCandidate = manifestPath ? normalizePath(manifestPath) : normalizePath(joinPath(rootPath, ".claude-plugin/plugin.json"))
  const explicitManifest = manifestCandidate ? readJsonMap(fileTextByPath, manifestCandidate) : null
  if (isRecord(explicitManifest)) {
    return {
      description: asString(explicitManifest.description),
      metadata: explicitManifest,
      name: asString(explicitManifest.name),
    }
  }

  const fallbackPluginJson = readJsonMap(fileTextByPath, joinPath(rootPath, "plugin.json"))
  if (isRecord(fallbackPluginJson)) {
    return {
      description: asString(fallbackPluginJson.description),
      metadata: fallbackPluginJson,
      name: asString(fallbackPluginJson.name),
    }
  }

  return {
    description: null,
    metadata: {},
    name: null,
  }
}

function collectComponentPaths(knownPaths: Set<string>, rootPath: string) {
  const componentPaths = {
    agents: [] as string[],
    commands: [] as string[],
    hooks: [] as string[],
    lspServers: [] as string[],
    mcpServers: [] as string[],
    monitors: [] as string[],
    settings: [] as string[],
    skills: [] as string[],
  }

  const candidates: Array<[keyof typeof componentPaths, string]> = [
    ["skills", joinPath(rootPath, "skills")],
    ["skills", joinPath(rootPath, ".claude/skills")],
    ["commands", joinPath(rootPath, "commands")],
    ["commands", joinPath(rootPath, ".claude/commands")],
    ["agents", joinPath(rootPath, "agents")],
    ["agents", joinPath(rootPath, ".claude/agents")],
    ["hooks", joinPath(rootPath, "hooks/hooks.json")],
    ["mcpServers", joinPath(rootPath, ".mcp.json")],
    ["lspServers", joinPath(rootPath, ".lsp.json")],
    ["monitors", joinPath(rootPath, "monitors/monitors.json")],
    ["settings", joinPath(rootPath, "settings.json")],
  ]

  for (const [bucket, candidate] of candidates) {
    if (!candidate) continue
    if (bucket === "hooks" || bucket === "mcpServers" || bucket === "lspServers" || bucket === "monitors" || bucket === "settings") {
      if (hasPath(knownPaths, candidate)) {
        componentPaths[bucket].push(candidate)
      }
      continue
    }

    if (hasDescendant(knownPaths, candidate)) {
      componentPaths[bucket].push(candidate)
    }
  }

  return componentPaths
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const normalized = asString(entry)
        return normalized ? [normalized] : []
      })
    : []
}

function marketplaceComponentPaths(entry: MarketplaceEntry, knownPaths: Set<string>, rootPath: string) {
  const collect = (values: unknown, { file, directory }: { file?: boolean; directory?: boolean }) => {
    const paths: string[] = []
    for (const value of readStringArray(values)) {
      const candidate = joinPath(rootPath, value)
      if (!candidate && !rootPath) {
        continue
      }
      if ((directory && hasDescendant(knownPaths, candidate)) || (file && hasPath(knownPaths, candidate))) {
        paths.push(candidate)
      }
    }
    return paths
  }

  return {
    agents: collect(entry.agents, { directory: true }),
    commands: collect(entry.commands, { directory: true }),
    hooks: collect(entry.hooks, { file: true, directory: true }),
    lspServers: [],
    mcpServers: collect(entry.mcpServers, { file: true }),
    monitors: [],
    settings: collect(entry.settings, { file: true }),
    skills: collect(entry.skills, { directory: true }),
  } satisfies GithubDiscoveredPlugin["componentPaths"]
}

function hasAnyComponentPaths(componentPaths: GithubDiscoveredPlugin["componentPaths"]) {
  return Object.values(componentPaths).some((paths) => paths.length > 0)
}

function componentKindsFromPaths(componentPaths: GithubDiscoveredPlugin["componentPaths"]): GithubDiscoveredPluginComponentKind[] {
  const kinds: GithubDiscoveredPluginComponentKind[] = []
  if (componentPaths.skills.length > 0) kinds.push("skill")
  if (componentPaths.commands.length > 0) kinds.push("command")
  if (componentPaths.agents.length > 0) kinds.push("agent")
  if (componentPaths.hooks.length > 0) kinds.push("hook")
  if (componentPaths.mcpServers.length > 0) kinds.push("mcp_server")
  if (componentPaths.lspServers.length > 0) kinds.push("lsp_server")
  if (componentPaths.monitors.length > 0) kinds.push("monitor")
  if (componentPaths.settings.length > 0) kinds.push("settings")
  return kinds
}

function buildDiscoveredPlugin(input: {
  componentPathsOverride?: GithubDiscoveredPlugin["componentPaths"] | null
  description?: string | null
  displayName?: string | null
  fileTextByPath: Record<string, string | null | undefined>
  key: string
  knownPaths: Set<string>
  manifestPath?: string | null
  rootPath: string
  sourceKind: GithubDiscoveredPluginSourceKind
  supported?: boolean
  warnings?: string[]
}) {
  const metadata = readPluginMetadata(input.fileTextByPath, input.rootPath, input.manifestPath)
  const componentPaths = input.componentPathsOverride ?? collectComponentPaths(input.knownPaths, input.rootPath)
  const displayName = input.displayName?.trim()
    || metadata.name
    || basename(input.rootPath)
    || "Repository plugin"

  return {
    componentKinds: componentKindsFromPaths(componentPaths),
    componentPaths,
    description: input.description ?? metadata.description,
    displayName,
    key: input.key,
    manifestPath: input.manifestPath ? normalizePath(input.manifestPath) : (hasPath(input.knownPaths, joinPath(input.rootPath, ".claude-plugin/plugin.json")) ? joinPath(input.rootPath, ".claude-plugin/plugin.json") : null),
    metadata: metadata.metadata,
    rootPath: normalizePath(input.rootPath),
    selectedByDefault: input.supported !== false,
    sourceKind: input.sourceKind,
    supported: input.supported !== false,
    warnings: input.warnings ?? [],
  } satisfies GithubDiscoveredPlugin
}

function localMarketplaceRoot(entry: MarketplaceEntry) {
  if (typeof entry.source === "string") {
    return normalizePath(entry.source)
  }

  if (!isRecord(entry.source)) {
    return null
  }

  if (typeof entry.source.url === "string") {
    return null
  }

  const localPath = asString(entry.source.path)
  return localPath ? normalizePath(localPath) : null
}

function pluginRootsFromManifests(entries: GithubDiscoveryTreeEntry[]) {
  return entries
    .map((entry) => normalizePath(entry.path))
    .filter((path) => path.endsWith(".claude-plugin/plugin.json"))
    .map((path) => path.slice(0, -"/.claude-plugin/plugin.json".length))
}

function inferredRootsFromKnownFolders(entries: GithubDiscoveryTreeEntry[]) {
  const inferred = new Set<string>()
  for (const entry of entries) {
    const normalized = normalizePath(entry.path)
    if (!normalized) continue
    const segments = normalized.split("/")
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]
      if (!KNOWN_COMPONENT_SEGMENTS.includes(segment as (typeof KNOWN_COMPONENT_SEGMENTS)[number])) {
        continue
      }
      const rootSegments = segments.slice(0, index)
      if (rootSegments.length === 1 && rootSegments[0] === ".claude") {
        inferred.add("")
        continue
      }
      inferred.add(rootSegments.join("/"))
      break
    }
  }
  return [...inferred]
}

export function buildGithubRepoDiscovery(input: {
  entries: GithubDiscoveryTreeEntry[]
  fileTextByPath: Record<string, string | null | undefined>
}) {
  const knownPaths = buildPathSet(input.entries)
  const warnings: string[] = []

  if (hasPath(knownPaths, ".claude-plugin/marketplace.json")) {
    const marketplaceJson = readJsonMap(input.fileTextByPath, ".claude-plugin/marketplace.json")
    const marketplaceEntries = isRecord(marketplaceJson) && Array.isArray(marketplaceJson.plugins)
      ? marketplaceJson.plugins.filter(isRecord) as MarketplaceEntry[]
      : []

    const marketplaceInfo: GithubMarketplaceInfo = isRecord(marketplaceJson)
      ? {
          description: asString(marketplaceJson.description),
          name: asString(marketplaceJson.name),
          owner: isRecord(marketplaceJson.owner)
            ? asString(marketplaceJson.owner.name) ?? asString(marketplaceJson.owner.login) ?? asString(marketplaceJson.owner)
            : asString(marketplaceJson.owner),
          version: asString(marketplaceJson.version),
        }
      : { description: null, name: null, owner: null, version: null }

    const discoveredPlugins = marketplaceEntries.map((entry, index) => {
      const rootPath = localMarketplaceRoot(entry)
      if (rootPath === null) {
        const warning = "Marketplace entry points at an external source and cannot be auto-mapped from this connected repo yet."
        warnings.push(warning)
        return buildDiscoveredPlugin({
          description: asString(entry.description),
          displayName: asString(entry.name) ?? `Marketplace plugin ${index + 1}`,
          fileTextByPath: input.fileTextByPath,
          key: `marketplace:${asString(entry.name) ?? index}`,
          knownPaths,
          manifestPath: null,
          rootPath: "",
          sourceKind: "marketplace_entry",
          supported: false,
          warnings: [warning],
        })
      }

      return buildDiscoveredPlugin({
        componentPathsOverride: (() => {
          const override = marketplaceComponentPaths(entry, knownPaths, rootPath)
          return hasAnyComponentPaths(override) ? override : null
        })(),
        description: asString(entry.description),
        displayName: asString(entry.name),
        fileTextByPath: input.fileTextByPath,
        key: `marketplace:${rootPath}`,
        knownPaths,
        manifestPath: joinPath(rootPath, ".claude-plugin/plugin.json"),
        rootPath,
        sourceKind: "marketplace_entry",
      })
    })

    return {
      classification: "claude_marketplace_repo",
      discoveredPlugins,
      marketplace: marketplaceInfo,
      warnings,
    } satisfies GithubRepoDiscoveryResult
  }

  const manifestRoots = [...new Set(pluginRootsFromManifests(input.entries))]
  if (manifestRoots.length > 0) {
    const discoveredPlugins = manifestRoots.map((rootPath) => buildDiscoveredPlugin({
      fileTextByPath: input.fileTextByPath,
      key: `manifest:${rootPath || "root"}`,
      knownPaths,
      manifestPath: joinPath(rootPath, ".claude-plugin/plugin.json"),
      rootPath,
      sourceKind: "plugin_manifest",
    }))

    return {
      classification: manifestRoots.length === 1 && manifestRoots[0] === "" ? "claude_single_plugin_repo" : "claude_multi_plugin_repo",
      discoveredPlugins,
      marketplace: null,
      warnings,
    } satisfies GithubRepoDiscoveryResult
  }

  // Intentionally disabled for now: directory-based inference can over-classify
  // arbitrary repos as plugins. Until we support a broader compatibility model,
  // discovery should only accept explicit Claude plugin markers.
  // const inferredRoots = inferredRootsFromKnownFolders(input.entries)
  // const standaloneRoot = inferredRoots.includes("") && (
  //   hasDescendant(knownPaths, ".claude/skills")
  //   || hasDescendant(knownPaths, ".claude/commands")
  //   || hasDescendant(knownPaths, ".claude/agents")
  // )
  // const folderRoots = standaloneRoot ? inferredRoots : inferredRoots.filter((root) => root !== "")
  //
  // if (folderRoots.length > 0) {
  //   const discoveredPlugins = folderRoots.map((rootPath) => buildDiscoveredPlugin({
  //     fileTextByPath: input.fileTextByPath,
  //     key: `${standaloneRoot && rootPath === "" ? "standalone" : "folder"}:${rootPath || "root"}`,
  //     knownPaths,
  //     rootPath,
  //     sourceKind: standaloneRoot && rootPath === "" ? "standalone_claude" : "folder_inference",
  //   }))
  //
  //   return {
  //     classification: "folder_inferred_repo",
  //     discoveredPlugins,
  //     warnings,
  //   } satisfies GithubRepoDiscoveryResult
  // }

  warnings.push("OpenWork currently only supports Claude-compatible plugins and marketplaces. Add `.claude-plugin/marketplace.json` or `.claude-plugin/plugin.json` to this repository.")

  return {
    classification: "unsupported",
    discoveredPlugins: [],
    marketplace: null,
    warnings,
  } satisfies GithubRepoDiscoveryResult
}
