const REACT_SESSION_FLAG = "openwork:react-session";

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function reactSessionEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (isTruthyFlag(import.meta.env.VITE_OPENWORK_REACT_SESSION)) return true;
    const query = new URLSearchParams(window.location.search).get("react");
    if (query === "1" || query === "true") return true;
    if (query === "0" || query === "false") return false;
    const stored = window.localStorage.getItem(REACT_SESSION_FLAG);
    return stored === "1" || stored === "true";
  } catch {
    return false;
  }
}
