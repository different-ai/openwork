import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"

export function artifactViewResourceUri(artifactViewId: string, revisionId: string): string {
  const normalizedViewId = normalizeDenTypeId("artifactView", artifactViewId)
  const normalizedRevisionId = normalizeDenTypeId("artifactViewRevision", revisionId)
  return `ui://openwork/artifacts/${normalizedViewId}/views/${normalizedRevisionId}/index.html`
}
