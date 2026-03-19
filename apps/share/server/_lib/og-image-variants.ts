export type OgImageVariant = "facebook" | "twitter" | "linkedin" | "slack" | "whatsapp";

export interface OgImageVariantConfig {
  key: OgImageVariant;
  label: string;
  width: number;
  height: number;
}

export const BASE_OG_IMAGE_WIDTH = 1200;
export const BASE_OG_IMAGE_HEIGHT = 630;
export const DEFAULT_OG_IMAGE_VARIANT: OgImageVariant = "facebook";
export const DEFAULT_TWITTER_IMAGE_VARIANT: OgImageVariant = "twitter";

export const OG_IMAGE_VARIANTS: Record<OgImageVariant, OgImageVariantConfig> = {
  facebook: {
    key: "facebook",
    label: "Facebook",
    width: 1200,
    height: 630,
  },
  twitter: {
    key: "twitter",
    label: "Twitter",
    width: 1200,
    height: 600,
  },
  linkedin: {
    key: "linkedin",
    label: "LinkedIn",
    width: 1200,
    height: 627,
  },
  slack: {
    key: "slack",
    label: "Slack",
    width: 1200,
    height: 630,
  },
  whatsapp: {
    key: "whatsapp",
    label: "WhatsApp",
    width: 1200,
    height: 630,
  },
};

export function parseOgImageVariant(value: unknown, fallback: OgImageVariant = DEFAULT_OG_IMAGE_VARIANT): OgImageVariant {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized in OG_IMAGE_VARIANTS) {
    return normalized as OgImageVariant;
  }
  return fallback;
}

export function getOgImageVariantConfig(value: unknown, fallback?: OgImageVariant): OgImageVariantConfig {
  return OG_IMAGE_VARIANTS[parseOgImageVariant(value, fallback)];
}
