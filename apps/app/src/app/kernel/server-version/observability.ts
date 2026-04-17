import { recordDevLog } from "../../lib/dev-log";

export function recordServerVersionDecision(
  enabled: boolean,
  label: string,
  payload: Record<string, unknown>,
) {
  recordDevLog(enabled, {
    level: "debug",
    source: "server-version",
    label,
    payload,
  });

  if (!enabled) return;
  try {
    console.debug(`[server-version] ${label}`, payload);
  } catch {
    // ignore
  }
}
