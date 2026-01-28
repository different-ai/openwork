import type { RemoteSkillItem, RemoteSkillSource } from "./types.js";
import { ApiError } from "./errors.js";
import { validateSkillName } from "./validators.js";
import { upsertSkill } from "./skills.js";

type ParsedGitHubSource = {
  input: string;
  id: string;
  repo: string;
  ref: string | null;
  pathPrefix: string | null;
};

const SKILL_ROOTS = [".opencode/skills", ".opencode/skill", ".claude/skills"] as const;
const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const CACHE_TTL_MS = 5 * 60 * 1000;

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "openwork-server",
};

const remoteSkillCache = new Map<
  string,
  {
    fetchedAt: number;
    source: RemoteSkillSource;
    items: RemoteSkillItem[];
  }
>();

const normalizePathPrefix = (value: string | null | undefined) => {
  if (!value) return null;
  const normalized = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => part === "." || part === "..")) return null;
  return normalized;
};

const buildSourceId = (repo: string, ref: string | null, pathPrefix: string | null) =>
  ["github", repo, ref ?? "", pathPrefix ?? ""].join("|");

const parseGitHubSourceInput = (input: string): ParsedGitHubSource | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("github:")) {
    const rest = trimmed.slice("github:".length).trim();
    const [repoPart, refPart] = rest.split("#", 2);
    const repoSegments = repoPart.split("/").filter(Boolean);
    if (repoSegments.length !== 2) return null;
    const repo = `${repoSegments[0]}/${repoSegments[1].replace(/\.git$/i, "")}`;
    const ref = refPart ? refPart.trim() : null;
    const pathPrefix = normalizePathPrefix(null);
    return {
      input: trimmed,
      id: buildSourceId(repo, ref, pathPrefix),
      repo,
      ref,
      pathPrefix,
    };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (!GITHUB_HOSTS.has(url.hostname)) return null;
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length < 2) return null;
      const owner = segments[0];
      const repoName = segments[1].replace(/\.git$/i, "");
      const repo = `${owner}/${repoName}`;
      let ref: string | null = null;
      let pathPrefix: string | null = null;
      if (segments[2] === "tree" && segments[3]) {
        ref = segments[3];
        pathPrefix = normalizePathPrefix(segments.slice(4).join("/"));
      }
      return {
        input: trimmed,
        id: buildSourceId(repo, ref, pathPrefix),
        repo,
        ref,
        pathPrefix,
      };
    } catch {
      return null;
    }
  }

  return null;
};

const extractSkillDescription = (raw: string) => {
  let inFrontmatter = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) continue;
    if (trimmed.startsWith("#")) continue;
    const cleaned = trimmed.replace(/`/g, "");
    if (!cleaned) continue;
    if (cleaned.length > 180) return `${cleaned.slice(0, 180)}...`;
    return cleaned;
  }
  return null;
};

const matchSkillPath = (path: string, pathPrefix: string | null) => {
  const normalized = path.replace(/^\/+/, "");
  const scoped = pathPrefix
    ? normalized.startsWith(`${pathPrefix}/`)
      ? normalized.slice(pathPrefix.length + 1)
      : null
    : normalized;
  if (!scoped) return null;
  for (const root of SKILL_ROOTS) {
    const rootPrefix = `${root}/`;
    if (!scoped.startsWith(rootPrefix)) continue;
    const remainder = scoped.slice(rootPrefix.length);
    const parts = remainder.split("/");
    if (parts.length !== 2) continue;
    const [name, fileName] = parts;
    if (fileName !== "SKILL.md") continue;
    if (!SKILL_NAME_REGEX.test(name)) continue;
    return {
      name,
      skillFilePath: normalized,
      skillDirPath: normalized.replace(/\/SKILL\.md$/i, ""),
    };
  }
  return null;
};

const buildRawUrl = (repo: string, ref: string, path: string) =>
  `https://raw.githubusercontent.com/${repo}/${ref}/${path.replace(/^\/+/, "")}`;

const fetchGithubJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, { headers: GITHUB_HEADERS });
  if (!response.ok) {
    const error = new Error(`GitHub request failed (${response.status})`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return response.json() as Promise<T>;
};

const fetchGithubText = async (url: string): Promise<string> => {
  const response = await fetch(url, { headers: GITHUB_HEADERS });
  if (!response.ok) {
    const error = new Error(`GitHub request failed (${response.status})`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return response.text();
};

const resolveDefaultBranch = async (repo: string) => {
  const payload = await fetchGithubJson<{ default_branch?: string }>(
    `https://api.github.com/repos/${repo}`,
  );
  if (!payload.default_branch) {
    throw new Error("GitHub repo missing default branch");
  }
  return payload.default_branch;
};

const fetchTree = async (repo: string, ref: string) =>
  fetchGithubJson<{ tree: Array<{ path: string; type: string }>; truncated?: boolean }>(
    `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`,
  );

const errorMessageForGitHub = (error: unknown) => {
  const status = typeof (error as { status?: number })?.status === "number"
    ? (error as { status?: number }).status
    : null;
  if (status === 404) return "GitHub repo not found.";
  if (status === 403 || status === 429) return "GitHub rate limit exceeded.";
  return error instanceof Error ? error.message : "Failed to load remote skills.";
};

const resolveSourceSkills = async (source: ParsedGitHubSource) => {
  const ref = source.ref ?? (await resolveDefaultBranch(source.repo));
  const tree = await fetchTree(source.repo, ref);
  if (tree.truncated) {
    throw new Error("GitHub repo tree truncated. Try a smaller repo.");
  }

  const matched = new Map<string, { name: string; skillFilePath: string; skillDirPath: string }>();
  for (const entry of tree.tree) {
    if (entry.type !== "blob" || !entry.path.endsWith("SKILL.md")) continue;
    const match = matchSkillPath(entry.path, source.pathPrefix);
    if (!match) continue;
    if (!matched.has(match.name)) {
      matched.set(match.name, match);
    }
  }

  const items = await Promise.all(
    Array.from(matched.values()).map(async (match) => {
      const contentUrl = buildRawUrl(source.repo, ref, match.skillFilePath);
      let description: string | null = null;
      try {
        const content = await fetchGithubText(contentUrl);
        description = extractSkillDescription(content);
      } catch {
        description = null;
      }

      return {
        id: `${source.id}:${match.name}`,
        sourceId: source.id,
        sourceInput: source.input,
        name: match.name,
        description,
        repo: source.repo,
        ref,
        path: match.skillDirPath,
        skillFilePath: match.skillFilePath,
        contentUrl,
      } satisfies RemoteSkillItem;
    }),
  );

  return { items: items.sort((a, b) => a.name.localeCompare(b.name)), resolvedRef: ref };
};

export async function listRemoteSkills(sources: string[]): Promise<{ sources: RemoteSkillSource[]; items: RemoteSkillItem[] }> {
  const sourceInputs = Array.isArray(sources) ? sources : [];
  if (sourceInputs.length === 0) {
    throw new ApiError(400, "invalid_sources", "At least one remote source is required");
  }

  const items: RemoteSkillItem[] = [];
  const sourceStatus: RemoteSkillSource[] = [];

  for (const raw of sourceInputs) {
    const parsed = parseGitHubSourceInput(String(raw ?? ""));
    if (!parsed) {
      sourceStatus.push({
        id: `invalid:${raw}`,
        input: String(raw ?? ""),
        repo: "",
        ref: null,
        pathPrefix: null,
        status: "error",
        errorMessage: "Invalid GitHub source.",
      });
      continue;
    }

    const cached = remoteSkillCache.get(parsed.id);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      sourceStatus.push({ ...cached.source, input: parsed.input });
      items.push(...cached.items);
      continue;
    }

    try {
      const resolved = await resolveSourceSkills(parsed);
      const sourceInfo: RemoteSkillSource = {
        id: parsed.id,
        input: parsed.input,
        repo: parsed.repo,
        ref: parsed.ref,
        pathPrefix: parsed.pathPrefix,
        resolvedRef: resolved.resolvedRef,
        status: "success",
      };
      sourceStatus.push(sourceInfo);
      items.push(...resolved.items);
      remoteSkillCache.set(parsed.id, {
        fetchedAt: Date.now(),
        source: sourceInfo,
        items: resolved.items,
      });
    } catch (error) {
      sourceStatus.push({
        id: parsed.id,
        input: parsed.input,
        repo: parsed.repo,
        ref: parsed.ref,
        pathPrefix: parsed.pathPrefix,
        status: "error",
        errorMessage: errorMessageForGitHub(error),
      });
    }
  }

  return { sources: sourceStatus, items };
}

export async function installRemoteSkill(
  workspaceRoot: string,
  payload: { source: string; path: string; name: string },
): Promise<{ name: string; path: string; description: string }> {
  const parsed = parseGitHubSourceInput(payload.source ?? "");
  if (!parsed) {
    throw new ApiError(400, "invalid_source", "Invalid GitHub source");
  }

  const name = String(payload.name ?? "").trim();
  validateSkillName(name);

  const rawPath = String(payload.path ?? "").trim();
  if (!rawPath) {
    throw new ApiError(400, "invalid_path", "Skill path is required");
  }

  const match = matchSkillPath(rawPath, parsed.pathPrefix);
  if (!match || match.name !== name) {
    throw new ApiError(400, "invalid_skill_path", "Skill path does not match skill name");
  }

  const ref = parsed.ref ?? (await resolveDefaultBranch(parsed.repo));
  const contentUrl = buildRawUrl(parsed.repo, ref, match.skillFilePath);
  let content = "";
  try {
    content = await fetchGithubText(contentUrl);
  } catch (error) {
    throw new ApiError(502, "github_fetch_failed", errorMessageForGitHub(error));
  }

  const description = extractSkillDescription(content) ?? name;
  const path = await upsertSkill(workspaceRoot, { name, content, description });
  return { name, path, description };
}
