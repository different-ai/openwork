// Retained source settings, including while whiteLabel is disabled. Extraction
// never implies enablement: native/UI consumers require the explicit resolved
// whiteLabelEnabled flag. Keep the original bytes of each value.
export function dormantDesktopBrandSettings(input) {
  return Object.fromEntries(
    ["brandAppName", "brandLogoUrl", "brandIconUrl"]
      .filter((key) => typeof input?.[key] === "string" || input?.[key] === null)
      .map((key) => [key, input[key]]),
  );
}

function origin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function sameDesktopDenOrigin(previous, next) {
  const previousOrigin = origin(previous?.baseUrl);
  if (!previousOrigin || previousOrigin !== origin(next?.baseUrl)) return false;
  // A web origin can front multiple API deployments. Do not copy another
  // deployment's settings when both records explicitly identify their API.
  if (!previous?.apiBaseUrl || !next?.apiBaseUrl) return true;
  const previousApiOrigin = origin(previous.apiBaseUrl);
  return previousApiOrigin !== null && previousApiOrigin === origin(next.apiBaseUrl);
}
