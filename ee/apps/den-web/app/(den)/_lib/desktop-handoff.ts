export function getDesktopGrant(url: string | null): string | null {
  if (!url) return null;

  try {
    const grant = new URL(url).searchParams.get("grant")?.trim() ?? "";
    return grant || null;
  } catch {
    return null;
  }
}
