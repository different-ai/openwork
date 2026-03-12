export type ItemKind = "Agent" | "Skill" | "MCP" | "Config" | "Command";
export type ItemTone = "agent" | "skill" | "mcp" | "config" | "command";
export type StatusSeverity = "success" | "warn" | "info" | "neutral";
export type CopyState = "ready-not-copied" | "copied" | "copy-failed";
export type BusyMode = "preview" | "publish" | null;

export interface PreviewItem {
  name: string;
  kind: ItemKind;
  meta: string;
  tone: ItemTone;
  example?: string;
}

export interface PackageStatus {
  severity: StatusSeverity;
  label: string;
  items: string[];
}

export interface ShareFeedback {
  badge: string;
  detail: string;
  copyLabel: string;
  isSuccess: boolean;
}

export interface PackageStatusInput {
  generatedUrl: string;
  warnings: string[];
  effectiveEntryCount: number;
}

export interface FilePayload {
  name: string;
  path: string;
  content: string;
}

export interface PackageResponse {
  url?: string;
  warnings?: string[];
  items?: PreviewItem[];
  bundle?: Record<string, unknown>;
  summary?: Record<string, unknown>;
}

export interface EntryLike {
  name: string;
  text(): Promise<string>;
}
