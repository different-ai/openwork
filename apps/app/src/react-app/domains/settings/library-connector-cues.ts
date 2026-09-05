import type { DenExternalMcpPreset } from "../../../app/lib/den";
import { resolveExtensionIconUrl } from "../../design-system/extension-icon-src";

export type LibraryConnectorCue = {
  id: string;
  name: string;
  iconSrc?: string;
  iconSlug?: string;
  serviceUrl?: string;
  faviconDomain?: string;
};

const MAX_CONNECTOR_CUES = 5;
const FEATURED_PRESET_IDS = ["notion", "slack"] as const;
const PRESET_ICON_SLUGS: Record<string, string> = {
  notion: "notion",
  slack: "slack",
  linear: "linear",
  stripe: "stripe",
  sentry: "sentry",
  granola: "granola",
  polar: "polar",
  exa: "exa",
  render: "render",
};

const HOSTED_SUITE_CUES: LibraryConnectorCue[] = [
  {
    id: "google-workspace",
    name: "Google Workspace",
    iconSlug: "googleworkspace",
    faviconDomain: "google.com",
  },
  {
    id: "microsoft-365",
    name: "Microsoft 365",
    iconSlug: "microsoft365",
    faviconDomain: "microsoft365.com",
  },
];

export function libraryConnectorIconUrls(cue: LibraryConnectorCue): string[] {
  const primary = resolveExtensionIconUrl(cue);
  const fallbackService = cue.faviconDomain
    ? `https://${cue.faviconDomain}`
    : cue.serviceUrl;
  const serviceIcon = fallbackService
    ? resolveExtensionIconUrl({ serviceUrl: fallbackService })
    : undefined;
  return [...new Set([primary, serviceIcon].filter((url): url is string => Boolean(url)))];
}

function cueForPreset(preset: DenExternalMcpPreset): LibraryConnectorCue {
  return {
    id: preset.presetId,
    name: preset.displayName,
    iconSlug: PRESET_ICON_SLUGS[preset.presetId],
    serviceUrl: preset.url,
  };
}

export function libraryConnectorCues(
  presets: DenExternalMcpPreset[],
): LibraryConnectorCue[] {
  const uniquePresets = new Map(
    presets.map((preset) => [preset.presetId, preset] as const),
  );
  const featured = FEATURED_PRESET_IDS.flatMap((presetId) => {
    const preset = uniquePresets.get(presetId);
    if (!preset) return [];
    uniquePresets.delete(presetId);
    return [cueForPreset(preset)];
  });
  const additionalPresets = [...uniquePresets.values()].map(cueForPreset);

  return [...featured, ...HOSTED_SUITE_CUES, ...additionalPresets]
    .slice(0, MAX_CONNECTOR_CUES);
}
