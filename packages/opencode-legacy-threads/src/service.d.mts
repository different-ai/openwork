export const ENGINE_VERSION: "0.0.0-beta-19086";
export const PROVENANCE_KEY: "openworkLegacyHistory";
export function isLegacyThread(id: unknown): id is string;
export class LegacyHistoryError extends Error { code: string; status: number; constructor(code: string, message: string, status?: number); }
export interface LegacyThreadSummary {
  id: string; projectID: string; slug: string; directory: string; title: string; version: string; parentID?: string;
  time: { created: number; updated: number; archived?: number };
  legacyReference: { sourceID: string; sessionID: string };
}
export interface LegacyPage { data: LegacyThreadSummary[]; nextCursor: string | null; }
export interface LegacyMessage { info: Record<string, unknown>; parts: Record<string, unknown>[]; }
export interface LegacyRead { session: LegacyThreadSummary; data: LegacyMessage[]; nextCursor: string | null; }
export interface LegacyImportPlan {
  sourceID: string; sessionID: string; homeDirectory: string; converterVersion: string;
  sessions: Array<{ info: { id: string; metadata: Record<string, unknown>; [key: string]: unknown }; messages: Record<string, unknown>[]; location: { directory: string } }>;
  warnings: Array<{ sessionID: string; reason: string; message: string }>; resets: string[];
}
export function createLegacyHistoryService(options: { legacyDatabase: string; targetDatabase?: string }): {
  list(input: { directory: string; search?: string; limit?: number; before?: string; parentReference?: string }): Promise<LegacyPage>;
  read(input: { directory: string; reference: string; limit?: number; before?: string; messageID?: string }): Promise<LegacyRead>;
  prepareImport(input: { directory: string; reference: string }): Promise<LegacyImportPlan>;
};
export function continueLegacyThread(plan: LegacyImportPlan, target: {
  key: string; get(id: string): Promise<unknown>; import(payload: LegacyImportPlan["sessions"][number]): Promise<unknown>;
  onImported?(id: string, home: string): Promise<unknown>;
}, options?: { allowOmissions?: boolean }): Promise<{ sessionID: string }>;
