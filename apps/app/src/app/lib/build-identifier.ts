export type OpenWorkBuildIdentifierInput = {
  releaseVersion?: string | null;
  buildSha?: string | null;
};

function trimmedValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeRelease(value: string | null | undefined): string | null {
  const release = trimmedValue(value);
  if (!release) return null;
  return release.startsWith("v") ? release : `v${release}`;
}

function normalizeSha(value: string | null | undefined): string | null {
  const sha = trimmedValue(value);
  return sha ? sha.slice(0, 7) : null;
}

export function resolveOpenWorkBuildIdentifier(input: OpenWorkBuildIdentifierInput): string | null {
  const release = normalizeRelease(input.releaseVersion);
  if (release) return release;

  return normalizeSha(input.buildSha);
}

export const OPENWORK_BUILD_IDENTIFIER = resolveOpenWorkBuildIdentifier({
  releaseVersion: String(import.meta.env.VITE_OPENWORK_RELEASE_VERSION ?? ""),
  buildSha: String(import.meta.env.VITE_OPENWORK_BUILD_SHA ?? ""),
});

export const OPENWORK_BUILD_IDENTIFIER_LABEL = OPENWORK_BUILD_IDENTIFIER
  ? `OpenWork ${OPENWORK_BUILD_IDENTIFIER}`
  : null;
