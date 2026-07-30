// Loads and normalizes one discoverable brand definition.
//
// Brand-owned files live under brands/<id>/brand.json. Shared defaults are
// optional and live in brands/_defaults.json. BRANDKIT_CONFIG remains
// supported for one-off and backwards-compatible builds; BRANDKIT_BRAND is
// the normal selector used by local commands and CI.

import { readFileSync, existsSync } from "node:fs";
import { dirname, relative, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root = three levels up from scripts/brandkit/lib/config.mjs. */
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..", "..");

const BRAND_ID = (process.env.BRANDKIT_BRAND ?? "miniwork").trim() || "miniwork";
const CONFIG_OVERRIDE = (process.env.BRANDKIT_CONFIG ?? "").trim();
export const CONFIG_PATH = resolve(
  REPO_ROOT,
  CONFIG_OVERRIDE || `brands/${BRAND_ID}/brand.json`,
);
const DEFAULTS_PATH = resolve(REPO_ROOT, "brands/_defaults.json");

const RADIX_COLORS = new Set([
  "gray", "gold", "bronze", "brown", "yellow", "amber", "orange",
  "tomato", "red", "ruby", "crimson", "pink", "plum", "purple",
  "violet", "iris", "indigo", "blue", "cyan", "teal", "jade",
  "green", "grass", "lime", "mint", "sky",
]);

/** Feature groups a distributor can toggle in a brand.json. All default on. */
export const FEATURE_DEFAULTS = {
  brandName: true,
  accentColor: true,
  assets: true,
  desktopIdentity: true,
  providers: true,
  welcomeOverride: true,
  cloudHide: true,
  language: true,
  trim: true,
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Merge objects recursively; arrays and scalar values are brand overrides. */
function mergeConfig(base, override) {
  if (!isRecord(base) || !isRecord(override)) return override;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = isRecord(value) && isRecord(merged[key])
      ? mergeConfig(merged[key], value)
      : value;
  }
  return merged;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function repoRelative(path) {
  return relative(REPO_ROOT, path).replaceAll("\\", "/");
}

function normalizeFeatures(raw, label) {
  const features = { ...FEATURE_DEFAULTS };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!(key in FEATURE_DEFAULTS)) {
      throw new Error(
        `${label}: unknown feature "${key}" — known features: ${Object.keys(FEATURE_DEFAULTS).join(", ")}.`,
      );
    }
    if (typeof value !== "boolean") {
      throw new Error(`${label}: features.${key} must be a boolean.`);
    }
    features[key] = value;
  }
  return features;
}

function derivedAssets(assetDir) {
  return {
    mark: `${assetDir}/mark.svg`,
    logo: `${assetDir}/logo.svg`,
    logoSquare: `${assetDir}/logo-square.svg`,
    favicon32: `${assetDir}/favicon-32x32.png`,
    favicon16: `${assetDir}/favicon-16x16.png`,
    appleTouchIcon: `${assetDir}/apple-touch-icon.png`,
    desktopIconPng: `${assetDir}/icon.png`,
    desktopIconIco: `${assetDir}/icon.ico`,
    desktopIconIcns: `${assetDir}/icon.icns`,
  };
}

function normalizeAssets(brand, configDir, brandId) {
  if (typeof brand.image === "string" && brand.image.trim()) {
    const imagePath = resolve(configDir, brand.image);
    return {
      sourceImage: repoRelative(imagePath),
      assets: derivedAssets(`.brandkit/${brandId}`),
    };
  }

  // Legacy configs used repo-relative paths for each derived asset. Keep them
  // readable so a distributor can migrate one brand at a time.
  return {
    sourceImage: null,
    assets: Object.fromEntries(
      Object.entries(brand.assets ?? {}).map(([key, value]) => [
        key,
        typeof value === "string" ? repoRelative(resolve(REPO_ROOT, value)) : value,
      ]),
    ),
  };
}

/**
 * Read, merge, and lightly validate one brand definition. The normalized
 * shape intentionally stays compatible with the existing operation engine.
 */
export function loadConfig() {
  const label = `brand config at ${CONFIG_PATH}`;
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `${label} was not found. Add brands/<id>/brand.json or set BRANDKIT_CONFIG.`,
    );
  }

  const configDir = dirname(CONFIG_PATH);
  const source = readJson(CONFIG_PATH, label);
  let raw = {};

  if (existsSync(DEFAULTS_PATH)) {
    raw = mergeConfig(raw, readJson(DEFAULTS_PATH, "brands/_defaults.json"));
  }

  if (typeof source.extends === "string" && source.extends.trim()) {
    const parentPath = resolve(configDir, source.extends);
    raw = mergeConfig(raw, readJson(parentPath, `extended brand config at ${parentPath}`));
  }

  raw = mergeConfig(raw, source);

  const brand = raw.brand ?? {};
  const brandId = raw.id ?? (CONFIG_OVERRIDE ? basename(configDir) : BRAND_ID);
  if (!/^[a-z][a-z0-9-]*$/.test(brandId)) {
    throw new Error(`${label}: id "${brandId}" must be lowercase kebab-case.`);
  }
  if (!brand.name || typeof brand.name !== "string") {
    throw new Error(`${label}: brand.name is required.`);
  }
  if (!RADIX_COLORS.has(brand.accentColor)) {
    throw new Error(
      `${label}: brand.accentColor "${brand.accentColor}" is not a Radix color family.`,
    );
  }

  const normalizedAssets = normalizeAssets(brand, configDir, brandId);
  if (normalizedAssets.sourceImage && !existsSync(resolve(REPO_ROOT, normalizedAssets.sourceImage))) {
    throw new Error(
      `${label}: brand.image does not exist at ${normalizedAssets.sourceImage}.`,
    );
  }

  const scheme = raw.desktop?.deepLinkScheme ?? "openwork";
  if (!/^[a-z][a-z0-9-]*$/.test(scheme)) {
    throw new Error(
      `${label}: desktop.deepLinkScheme "${scheme}" must be lowercase, no ':' or '//'.`,
    );
  }

  // A non-English value forces a hard-locked single-language build. CI can
  // override it for a matrix entry with BRANDKIT_LANG.
  const envLang = (process.env.BRANDKIT_LANG ?? "").trim();
  const language = {
    default: envLang !== "" ? envLang : (raw.language?.default ?? "en"),
  };
  if (
    language.default !== "en" &&
    !existsSync(resolve(REPO_ROOT, `apps/app/src/i18n/locales/${language.default}.ts`))
  ) {
    throw new Error(
      `language "${language.default}" (from ${envLang ? "BRANDKIT_LANG" : `${label} language.default`}) has no locale file in apps/app/src/i18n/locales/.`,
    );
  }

  const welcomeRaw = {
    ...(raw.welcome ?? {}),
    ...(raw.welcomeByLang?.[language.default] ?? {}),
  };

  return {
    id: brandId,
    configPath: CONFIG_PATH,
    features: normalizeFeatures(raw.features, label),
    language,
    brand: {
      id: brandId,
      name: brand.name,
      shortName: brand.shortName ?? brand.name,
      displayName: brand.nameByLang?.[language.default] ?? brand.name,
      accentColor: brand.accentColor,
      image: normalizedAssets.sourceImage,
      assets: normalizedAssets.assets,
    },
    desktop: {
      appId: raw.desktop?.appId ?? "com.differentai.openwork",
      deepLinkScheme: scheme,
      productName: raw.desktop?.productName ?? null,
      updateFeed:
        raw.desktop?.updateFeed?.owner && raw.desktop?.updateFeed?.repo
          ? { owner: raw.desktop.updateFeed.owner, repo: raw.desktop.updateFeed.repo }
          : null,
    },
    providers: {
      allowed: raw.providers?.allowed ?? [],
      models: raw.providers?.models ?? [],
      modelNames: raw.providers?.modelNames ?? {},
      default: raw.providers?.default
        ? {
            ...raw.providers.default,
            displayName:
              raw.providers.default.displayNameByLang?.[language.default] ??
              raw.providers.default.displayName ?? null,
          }
        : null,
      keyCard: raw.providers?.keyCard ?? null,
      modelsCatalogUrl: raw.providers?.modelsCatalogUrl ?? null,
    },
    cloud: {
      hide: raw.cloud?.hide ?? true,
      requireSignin: raw.cloud?.requireSignin ?? false,
    },
    welcome: {
      showSignIn: welcomeRaw.showSignIn ?? false,
      title: welcomeRaw.title ?? null,
      subtitle: welcomeRaw.subtitle ?? null,
      getStartedHeading: welcomeRaw.getStartedHeading ?? "Get started",
      getStartedLabel: welcomeRaw.getStartedLabel ?? null,
      showcaseTitle: welcomeRaw.showcaseTitle ?? ["Your computer,", "but it works for you."],
      steps: welcomeRaw.steps ?? [
        { title: "Pick a folder", desc: "Choose any folder on your machine to get started." },
        { title: "Chat", desc: `Describe what you need. ${brand.name} handles the rest.` },
        { title: "Interact", desc: "Review results, approve actions, and iterate." },
      ],
      features: welcomeRaw.features ?? [],
    },
  };
}
