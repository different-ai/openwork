// The GitHub source adapter.
//
// Everything here is read-only metadata plus one asset download. The host never
// clones the repository, never runs a build, never runs a package-manager hook,
// and never executes anything the manifest names. Preview is reading, not
// running — that is the whole point of a prebuilt package format.
//
// The critical step is resolving a mutable ref to an immutable commit. A release
// tag can be moved, and a branch certainly can. Everything downstream is pinned
// to the commit SHA this resolves, so "the release changed after you reviewed
// it" becomes a detectable, reported failure instead of a silent substitution.

export type FetchResponseLike = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  arrayBuffer: () => Promise<ArrayBuffer>;
  text: () => Promise<string>;
  headers: { get: (name: string) => string | null };
};

/**
 * The transport this adapter is given.
 *
 * Injected rather than reached for: the server bans bare `fetch` so that all
 * external egress goes through `externalFetch`, which carries the configured
 * proxy and CA trust. Tests supply a fake with the same shape.
 */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<FetchResponseLike>;

export type RepositoryRef = { owner: string; name: string; canonicalUrl: string };

export class SourceError extends Error {
  constructor(
    readonly code: SourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export type SourceErrorCode =
  | "invalid_repository_url"
  | "repository_not_found"
  | "no_release"
  | "release_not_found"
  | "tag_unresolvable"
  | "manifest_not_found"
  | "manifest_too_large"
  | "asset_not_found"
  | "asset_too_large"
  | "download_failed"
  | "rate_limited"
  | "upstream_error";

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const NAME = "[A-Za-z0-9._-]{1,100}";
const REPO_URL = new RegExp(`^https://github\\.com/(${OWNER})/(${NAME})$`);

/** Accepts what a user actually pastes, and normalises to a canonical URL. */
export function parseRepositoryUrl(input: string): RepositoryRef {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 300) {
    throw new SourceError("invalid_repository_url", "Enter a public GitHub repository URL.");
  }
  let candidate = trimmed;
  if (!candidate.includes("://")) candidate = `https://${candidate}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new SourceError("invalid_repository_url", "That is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new SourceError("invalid_repository_url", "Use an https github.com URL.");
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new SourceError("invalid_repository_url", "Only github.com repositories are supported.");
  }
  // Tolerate the extra path a browser leaves behind, and a .git suffix.
  const segments = url.pathname.split("/").filter(Boolean);
  const owner = segments[0];
  const rawName = segments[1];
  if (!owner || !rawName) {
    throw new SourceError("invalid_repository_url", "The URL must include an owner and repository.");
  }
  const name = rawName.replace(/\.git$/, "");
  const canonicalUrl = `https://github.com/${owner}/${name}`;
  if (!REPO_URL.test(canonicalUrl)) {
    throw new SourceError("invalid_repository_url", "That does not look like a repository URL.");
  }
  return { owner, name, canonicalUrl };
}

export type ReleaseAsset = { name: string; url: string; size: number };

export type ResolvedRelease = {
  repository: RepositoryRef;
  tag: string;
  /** Immutable. Everything downstream is bound to this. */
  commit: string;
  assets: ReleaseAsset[];
  publishedAt: string | null;
  prerelease: boolean;
};

const API = "https://api.github.com";
const MAX_MANIFEST_BYTES = 512 * 1024;

export type GithubClientOptions = {
  fetch: FetchLike;
  /** Optional token, used only to raise the anonymous rate limit. Never sent to an app. */
  token?: string;
  maxAssetBytes: number;
};

export class GithubSource {
  readonly #transport: FetchLike;
  readonly #token: string | undefined;
  readonly #maxAssetBytes: number;

  constructor(options: GithubClientOptions) {
    this.#transport = options.fetch;
    this.#token = options.token;
    this.#maxAssetBytes = options.maxAssetBytes;
  }

  #headers(accept = "application/vnd.github+json"): Record<string, string> {
    const headers: Record<string, string> = {
      accept,
      "user-agent": "OpenWork-Apps",
      "x-github-api-version": "2022-11-28",
    };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    return headers;
  }

  async #json(url: string, notFound: SourceErrorCode, notFoundMessage: string): Promise<unknown> {
    const response = await this.#transport(url, { headers: this.#headers() });
    if (response.status === 404) throw new SourceError(notFound, notFoundMessage);
    if (response.status === 403 || response.status === 429) {
      throw new SourceError("rate_limited", "GitHub rate limit reached. Try again in a few minutes.");
    }
    if (!response.ok) {
      throw new SourceError("upstream_error", `GitHub returned ${response.status}.`);
    }
    return response.json();
  }

  /** Latest published release, ignoring drafts. */
  async resolveLatestRelease(repository: RepositoryRef): Promise<ResolvedRelease> {
    const payload = await this.#json(
      `${API}/repos/${repository.owner}/${repository.name}/releases/latest`,
      "no_release",
      "This repository has no published release. OpenWork installs only released packages.",
    );
    return this.#toRelease(repository, payload);
  }

  async resolveReleaseByTag(repository: RepositoryRef, tag: string): Promise<ResolvedRelease> {
    const payload = await this.#json(
      `${API}/repos/${repository.owner}/${repository.name}/releases/tags/${encodeURIComponent(tag)}`,
      "release_not_found",
      `No release is tagged ${tag}.`,
    );
    return this.#toRelease(repository, payload);
  }

  async #toRelease(repository: RepositoryRef, payload: unknown): Promise<ResolvedRelease> {
    if (typeof payload !== "object" || payload === null) {
      throw new SourceError("upstream_error", "GitHub returned an unexpected release payload.");
    }
    const record = payload as Record<string, unknown>;
    if (record.draft === true) {
      throw new SourceError("no_release", "The latest release is still a draft.");
    }
    const tag = typeof record.tag_name === "string" ? record.tag_name : "";
    if (!tag) throw new SourceError("upstream_error", "The release has no tag.");

    const assets = Array.isArray(record.assets)
      ? record.assets.flatMap((entry): ReleaseAsset[] => {
          if (typeof entry !== "object" || entry === null) return [];
          const asset = entry as Record<string, unknown>;
          const name = typeof asset.name === "string" ? asset.name : "";
          const url = typeof asset.browser_download_url === "string" ? asset.browser_download_url : "";
          const size = typeof asset.size === "number" ? asset.size : 0;
          return name && url ? [{ name, url, size }] : [];
        })
      : [];

    return {
      repository,
      tag,
      commit: await this.resolveTagCommit(repository, tag),
      assets,
      publishedAt: typeof record.published_at === "string" ? record.published_at : null,
      prerelease: record.prerelease === true,
    };
  }

  /**
   * Resolve a tag to the commit it points at, dereferencing annotated tags.
   *
   * `target_commitish` on the release payload is not used: it can be a branch
   * name, which is exactly the mutable thing this step exists to eliminate.
   */
  async resolveTagCommit(repository: RepositoryRef, tag: string): Promise<string> {
    const base = `${API}/repos/${repository.owner}/${repository.name}`;
    const ref = await this.#json(
      `${base}/git/ref/tags/${encodeURIComponent(tag)}`,
      "tag_unresolvable",
      `The tag ${tag} could not be resolved to a commit.`,
    );
    const object = readObject(ref);
    if (!object) throw new SourceError("tag_unresolvable", `The tag ${tag} has no target.`);
    if (object.type === "commit") return object.sha;
    if (object.type !== "tag") {
      throw new SourceError("tag_unresolvable", `The tag ${tag} does not point at a commit.`);
    }
    const annotated = await this.#json(
      `${base}/git/tags/${object.sha}`,
      "tag_unresolvable",
      `The annotated tag ${tag} could not be read.`,
    );
    const target = readObject(annotated);
    if (!target || target.type !== "commit") {
      throw new SourceError("tag_unresolvable", `The tag ${tag} does not resolve to a commit.`);
    }
    return target.sha;
  }

  /** Read `openwork.app.json` at an exact commit. Never at a branch. */
  async fetchManifestAtCommit(repository: RepositoryRef, commit: string): Promise<string> {
    const response = await this.#transport(
      `${API}/repos/${repository.owner}/${repository.name}/contents/openwork.app.json?ref=${commit}`,
      { headers: this.#headers("application/vnd.github.raw+json") },
    );
    if (response.status === 404) {
      throw new SourceError(
        "manifest_not_found",
        "This repository has no openwork.app.json at the released commit, so it is not an OpenWork app.",
      );
    }
    if (response.status === 403 || response.status === 429) {
      throw new SourceError("rate_limited", "GitHub rate limit reached. Try again in a few minutes.");
    }
    if (!response.ok) throw new SourceError("upstream_error", `GitHub returned ${response.status}.`);

    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_MANIFEST_BYTES) {
      throw new SourceError("manifest_too_large", "openwork.app.json is implausibly large.");
    }
    const text = await response.text();
    if (text.length > MAX_MANIFEST_BYTES) {
      throw new SourceError("manifest_too_large", "openwork.app.json is implausibly large.");
    }
    return text;
  }

  findAsset(release: ResolvedRelease, name: string): ReleaseAsset {
    const asset = release.assets.find((entry) => entry.name === name);
    if (!asset) {
      throw new SourceError(
        "asset_not_found",
        `Release ${release.tag} has no asset named ${name}. The manifest says that is where the package lives.`,
      );
    }
    if (asset.size > this.#maxAssetBytes) {
      throw new SourceError("asset_too_large", `${name} is larger than OpenWork will install.`);
    }
    return asset;
  }

  async downloadAsset(asset: ReleaseAsset): Promise<Uint8Array> {
    const response = await this.#transport(asset.url, {
      headers: { ...this.#headers("application/octet-stream") },
    });
    if (!response.ok) {
      throw new SourceError("download_failed", `Downloading ${asset.name} failed (${response.status}).`);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > this.#maxAssetBytes) {
      throw new SourceError("asset_too_large", `${asset.name} is larger than OpenWork will install.`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Trust the bytes, not the header: a lying content-length must not let an
    // oversized download through.
    if (bytes.byteLength > this.#maxAssetBytes) {
      throw new SourceError("asset_too_large", `${asset.name} is larger than OpenWork will install.`);
    }
    return bytes;
  }
}

function readObject(payload: unknown): { sha: string; type: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const object = (payload as Record<string, unknown>).object;
  if (typeof object !== "object" || object === null) return null;
  const record = object as Record<string, unknown>;
  const sha = typeof record.sha === "string" ? record.sha : "";
  const type = typeof record.type === "string" ? record.type : "";
  return sha && type ? { sha, type } : null;
}
