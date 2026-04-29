import type { AuditEntry } from "../sync/session-audit-store";

type SessionAuditExportPayload = {
  sessionId: string;
  exportedAt: number;
  entries: AuditEntry[];
};

function toSessionAuditExportPayload(entries: AuditEntry[], sessionId: string): SessionAuditExportPayload {
  return {
    sessionId,
    exportedAt: Date.now(),
    entries,
  };
}

export function formatSessionAuditAsJson(entries: AuditEntry[], sessionId: string): string {
  const payload = toSessionAuditExportPayload(entries, sessionId);
  return JSON.stringify(payload, null, 2);
}

function buildAuditFilename(sessionId: string, exportedAtMs: number): string {
  const normalizedSessionId = sessionId.trim() || "session";
  const safeSessionId = normalizedSessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const isoStamp = new Date(exportedAtMs).toISOString().replace(/[:.]/g, "-");
  return `openwork-session-audit-${safeSessionId}-${isoStamp}.json`;
}

export function downloadSessionAuditJson(entries: AuditEntry[], sessionId: string): void {
  if (typeof window === "undefined") return;

  const payload = toSessionAuditExportPayload(entries, sessionId);
  const content = JSON.stringify(payload, null, 2);
  const filename = buildAuditFilename(payload.sessionId, payload.exportedAt);

  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
