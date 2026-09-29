import type { Database } from "bun:sqlite";
export function fixture(): Promise<{
  root: string; directory: string; other: string; source: string; db: Database;
  session(id: string, parent?: string | null, home?: string): unknown;
  message(id: string, sessionID: string, value: unknown, time?: number): unknown;
  part(id: string, messageID: string, sessionID: string, value: unknown): unknown;
  user: { role: string; time: { created: number }; agent: string; model: { providerID: string; modelID: string } };
  assistant(parentID: string): Record<string, unknown>;
  close(): Promise<void>;
}>;
