export type ReleaseAsset = {
  name?: string;
  browser_download_url?: string;
};

const DESKTOP_ASSET_PREFIXES = ["openwork-mac-", "openwork-win-", "openwork-linux-"];
const NON_INSTALLER_EXTENSIONS = /\.(blockmap|yml|yaml|json|txt|sig|sha256)$/i;

export function isStandardDesktopAssetName(name: string): boolean {
  const lower = name.toLowerCase();
  if (!DESKTOP_ASSET_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return false;
  }
  return !NON_INSTALLER_EXTENSIONS.test(lower);
}

export function isStandardDesktopAsset(asset: ReleaseAsset): asset is Required<ReleaseAsset> {
  return Boolean(asset.name && asset.browser_download_url && isStandardDesktopAssetName(asset.name));
}
