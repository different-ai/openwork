import type { RemoteSkillCard } from "../types";

export type ParsedGitHubSource = {
  input: string;
  id: string;
  repo: string;
  ref: string | null;
  pathPrefix: string | null;
};

const SKILL_ROOTS = [".opencode/skills", ".opencode/skill", ".claude/skills"] as const;
const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
};

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

export function parseGitHubSourceInput(input: string): ParsedGitHubSource | null {
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
}

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

const buildRawUrl = (repo: string, ref: string, path: string) =>
  `https://raw.githubusercontent.com/${repo}/${ref}/${path.replace(/^\/+/, "")}`;

export async function listGitHubSkills(source: ParsedGitHubSource): Promise<RemoteSkillCard[]> {
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

  const results = await Promise.all(
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
        name: match.name,
        description,
        sourceId: source.id,
        sourceInput: source.input,
        repo: source.repo,
        ref,
        path: match.skillDirPath,
        skillFilePath: match.skillFilePath,
        contentUrl,
      } satisfies RemoteSkillCard;
    }),
  );

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchRemoteSkillContent(skill: RemoteSkillCard): Promise<string> {
  return fetchGithubText(skill.contentUrl);
}
