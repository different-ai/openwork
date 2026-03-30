import {
  buildBundleNarrative,
  buildBundlePreview,
  buildBundlePreviewSelections,
  buildBundleUrls,
  buildOgImageUrl,
  buildOgImageUrls,
  buildOpenInAppUrls,
  collectBundleItems,
  getBundleCounts,
  humanizeType,
  parseBundle
} from "../_lib/share-utils.ts";
import { fetchBundleJsonById } from "../_lib/blob-store.ts";
import type { BundlePageProps, RequestLike } from "../_lib/types.ts";

function buildMetadataRows(
  id: string,
  bundle: ReturnType<typeof parseBundle>,
  counts: ReturnType<typeof getBundleCounts>,
  schemaVersion: string,
): { label: string; value: string }[] {
  return [
    { label: "ID", value: id },
    { label: "Type", value: bundle.type || "unknown" },
    { label: "Schema", value: schemaVersion },
    ...(counts.skillCount ? [{ label: "Skills", value: String(counts.skillCount) }] : []),
    ...(counts.agentCount ? [{ label: "Agents", value: String(counts.agentCount) }] : []),
    ...(counts.mcpCount ? [{ label: "MCPs", value: String(counts.mcpCount) }] : []),
    ...(counts.commandCount ? [{ label: "Commands", value: String(counts.commandCount) }] : []),
    ...(counts.configCount ? [{ label: "Configs", value: String(counts.configCount) }] : []),
    ...(counts.fileCount ? [{ label: "Files", value: String(counts.fileCount) }] : [])
  ];
}

export function buildMissingBundlePageProps(requestLike: RequestLike, id = "missing"): BundlePageProps {
  return {
    missing: true,
    canonicalUrl: buildBundleUrls(requestLike, id).shareUrl,
    ogImageUrl: buildOgImageUrl(requestLike, id),
    twitterImageUrl: buildOgImageUrl(requestLike, id, "twitter"),
    ogImageUrls: buildOgImageUrls(requestLike, id),
  };
}

export async function getBundlePageProps({ id, requestLike }: { id: string; requestLike: RequestLike }): Promise<BundlePageProps> {
  const normalizedId = String(id ?? "").trim();
  if (!normalizedId) {
    return buildMissingBundlePageProps(requestLike);
  }

  try {
    const { rawJson } = await fetchBundleJsonById(normalizedId);
    const bundle = parseBundle(rawJson);
    const urls = buildBundleUrls(requestLike, normalizedId);
    const ogImageUrls = buildOgImageUrls(requestLike, normalizedId);
    const ogImageUrl = ogImageUrls.default;
    const { openInAppDeepLink } = buildOpenInAppUrls(urls.shareUrl, {
      label: bundle.name || "Shared worker package"
    });
    const counts = getBundleCounts(bundle);
    const schemaVersion = bundle.schemaVersion == null ? "unknown" : String(bundle.schemaVersion);
    const typeLabel = humanizeType(bundle.type);
    const preview = buildBundlePreview(bundle);
    const title = bundle.name || `OpenWork ${typeLabel}`;
    const description = bundle.description || buildBundleNarrative(bundle);
    const installHint =
      bundle.type === "skill"
        ? "Open in app to choose where to add this skill."
        : bundle.type === "skills-set"
          ? "Open in app to add this full skills set to an existing worker or create a new worker with it attached."
          : "Open in app to create a new worker with these skills, commands, config, and portable .opencode files already bundled.";

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
      twitterImageUrl: ogImageUrls.twitter,
      ogImageUrls,
      openInAppDeepLink,
      installHint,
      bundleType: bundle.type || "unknown",
      typeLabel,
      schemaVersion,
      items: collectBundleItems(bundle, 8),
      previewFilename: preview.filename,
      previewText: preview.text,
      previewLabel: preview.label,
      previewTone: preview.tone,
      previewSelections: buildBundlePreviewSelections(bundle),
      metadataRows: buildMetadataRows(normalizedId, bundle, counts, schemaVersion)
    };
  } catch {
    return buildMissingBundlePageProps(requestLike, normalizedId);
  }
}
