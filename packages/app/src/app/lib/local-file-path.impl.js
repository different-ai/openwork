const FILE_URI_PREFIX_RE = /^file:(?:\/\/)?/i;
const WINDOWS_DRIVE_URI_PATH_RE = /^\/[A-Za-z]:\//;

const safeDecodeURIComponent = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const normalizeLocalFilePath = (value) => {
  const trimmed = String(value ?? "").trim();
  if (!FILE_URI_PREFIX_RE.test(trimmed)) return trimmed;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "file:") return trimmed;

    const pathname = safeDecodeURIComponent(parsed.pathname || "");
    if (!pathname) return trimmed;
    if (WINDOWS_DRIVE_URI_PATH_RE.test(pathname)) return pathname.slice(1);
    if (parsed.hostname && parsed.hostname.toLowerCase() !== "localhost") {
      return `//${parsed.hostname}${pathname}`;
    }
    return pathname;
  } catch {
    const decoded = safeDecodeURIComponent(trimmed.replace(FILE_URI_PREFIX_RE, ""));
    if (!decoded) return trimmed;
    if (WINDOWS_DRIVE_URI_PATH_RE.test(decoded)) return decoded.slice(1);
    return decoded;
  }
};
