const REACT_SESSION_FLAG = "openwork:react-session";

export function reactSessionEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const query = new URLSearchParams(window.location.search).get("react");
    if (query === "1" || query === "true") return true;
    if (query === "0" || query === "false") return false;
    const stored = window.localStorage.getItem(REACT_SESSION_FLAG);
    return stored === "1" || stored === "true";
  } catch {
    return false;
  }
}
