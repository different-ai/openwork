import {
  buildBundleNarrative,
  buildBundleUrls,
  buildOgImageUrl,
  buildOpenInAppUrls,
  collectBundleItems,
  getBundleCounts,
  humanizeType,
  parseBundle
} from "../_lib/share-utils.js";
import { fetchBundleJsonById } from "../_lib/blob-store.js";

function buildMetadataRows(id, bundle, counts, schemaVersion) {
  return [
    { label: "ID", value: id },
    { label: "Type", value: bundle.type || "unknown" },
    { label: "Schema", value: schemaVersion },
    ...(counts.skillCount ? [{ label: "Skills", value: String(counts.skillCount) }] : []),
    ...(counts.agentCount ? [{ label: "Agents", value: String(counts.agentCount) }] : []),
    ...(counts.mcpCount ? [{ label: "MCPs", value: String(counts.mcpCount) }] : []),
    ...(counts.commandCount ? [{ label: "Commands", value: String(counts.commandCount) }] : []),
    ...(counts.hasConfig ? [{ label: "Config", value: "yes" }] : [])
  ];
}

export function buildMissingBundlePageProps(requestLike, id = "missing") {
  return {
    missing: true,
    canonicalUrl: buildBundleUrls(requestLike, id).shareUrl,
    ogImageUrl: buildOgImageUrl(requestLike, "root")
  };
}

export async function getBundlePageProps({ id, requestLike }) {
  const normalizedId = String(id ?? "").trim();
  if (!normalizedId) {
    return buildMissingBundlePageProps(requestLike);
  }

  try {
    const { rawJson } = await fetchBundleJsonById(normalizedId);
    const bundle = parseBundle(rawJson);
    const urls = buildBundleUrls(requestLike, normalizedId);
    const ogImageUrl = buildOgImageUrl(requestLike, normalizedId);
    const { openInAppDeepLink, openInWebAppUrl } = buildOpenInAppUrls(urls.shareUrl, {
      label: bundle.name || "Shared worker package"
    });
    const counts = getBundleCounts(bundle);
    const schemaVersion = bundle.schemaVersion == null ? "unknown" : String(bundle.schemaVersion);
    const typeLabel = humanizeType(bundle.type);
    const title = bundle.name || `OpenWork ${typeLabel}`;
    const description = bundle.description || buildBundleNarrative(bundle);
    const installHint =
      bundle.type === "skill"
        ? "Open in app to create a new worker and install this skill in one step."
        : bundle.type === "skills-set"
          ? "Open in app to create a new worker with this entire skills set already attached."
          : "Open in app to create a new worker with these skills, agents, MCPs, and config already bundled.";

    return {
      missing: false,
      id: normalizedId,
      title,
      description,
      canonicalUrl: urls.shareUrl,
      shareUrl: urls.shareUrl,
      jsonUrl: urls.jsonUrl,
      downloadUrl: urls.downloadUrl,
      ogImageUrl,
      openInAppDeepLink,
      openInWebAppUrl,
      installHint,
      bundleType: bundle.type || "unknown",
      typeLabel,
      schemaVersion,
      items: collectBundleItems(bundle, 8),
      metadataRows: buildMetadataRows(normalizedId, bundle, counts, schemaVersion)
    };
  } catch {
    return buildMissingBundlePageProps(requestLike, normalizedId);
  }
}
