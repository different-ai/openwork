import { desktopFetch } from "./desktop";

export type ElectronAlphaArtifact = {
  arch: "arm64" | "x64";
  manifestUrl: string;
  releaseUrl: string;
  url: string;
  path: string;
  version: string;
  sha512: string;
};

const ELECTRON_ALPHA_RELEASE_BASE_URL =
  "https://github.com/different-ai/openwork/releases/download/alpha-macos-latest";

export const ELECTRON_ALPHA_RELEASE_PAGE_URL =
  "https://github.com/different-ai/openwork/releases/tag/alpha-macos-latest";

export const ELECTRON_ALPHA_LATEST_MAC_YML_URL = `${ELECTRON_ALPHA_RELEASE_BASE_URL}/latest-mac.yml`;

function parseYamlScalar(raw: string, key: string): string | null {
  const pattern = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m");
  const match = raw.match(pattern);
  if (!match?.[1]) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function parseFirstFileUrl(raw: string): string | null {
  const match = raw.match(/^\s*-\s+url:\s*(.+?)\s*$/m);
  if (!match?.[1]) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function resolveArtifactUrl(pathOrUrl: string): string {
  if (/^https:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return new URL(pathOrUrl, `${ELECTRON_ALPHA_RELEASE_BASE_URL}/`).toString();
}

export function parseElectronLatestMacYml(
  raw: string,
  arch: "arm64" | "x64",
): ElectronAlphaArtifact {
  const version = parseYamlScalar(raw, "version");
  const path = parseYamlScalar(raw, "path") ?? parseFirstFileUrl(raw);
  const sha512 = parseYamlScalar(raw, "sha512");

  if (!version) {
    throw new Error("latest-mac.yml is missing version.");
  }
  if (!path) {
    throw new Error("latest-mac.yml is missing artifact path/url.");
  }
  if (!sha512) {
    throw new Error("latest-mac.yml is missing sha512.");
  }

  return {
    arch,
    manifestUrl: ELECTRON_ALPHA_LATEST_MAC_YML_URL,
    releaseUrl: ELECTRON_ALPHA_RELEASE_PAGE_URL,
    url: resolveArtifactUrl(path),
    path,
    version,
    sha512,
  };
}

export async function resolveElectronAlphaArtifact(
  arch: "arm64" | "x64" = "arm64",
): Promise<ElectronAlphaArtifact> {
  const response = await desktopFetch(ELECTRON_ALPHA_LATEST_MAC_YML_URL, {
    headers: { Accept: "text/yaml, text/plain, */*" },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch latest-mac.yml (${response.status} ${response.statusText}).`,
    );
  }
  return parseElectronLatestMacYml(await response.text(), arch);
}
