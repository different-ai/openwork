import { z } from "zod";

/**
 * Responses of the openwork-server `/code-sessions*` routes: the machine-wide
 * mirror of coding-agent transcripts shown in the Code tab.
 */

export const codeSessionClientStateSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  available: z.boolean(),
});

export const codeSessionSummarySchema = z.object({
  client: z.string(),
  sessionId: z.string(),
  projectPath: z.string(),
  title: z.string(),
  startedAt: z.number(),
  updatedAt: z.number(),
  messageCount: z.number(),
  sizeBytes: z.number(),
});

export const codeSessionsListSchema = z.object({
  clients: z.array(codeSessionClientStateSchema),
  items: z.array(codeSessionSummarySchema),
});

export const codeSessionsClientsSchema = z.object({
  clients: z.array(codeSessionClientStateSchema),
});

export const importedToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  output: z.string(),
  failed: z.boolean(),
  time: z.number(),
});

export const importedMessageSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"),
    sourceId: z.string(),
    time: z.number(),
    text: z.string(),
  }),
  z.object({
    role: z.literal("assistant"),
    sourceId: z.string(),
    time: z.number(),
    completed: z.number(),
    model: z.string().optional(),
    blocks: z.array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({ type: z.literal("reasoning"), text: z.string() }),
        z.object({ type: z.literal("tool"), call: importedToolCallSchema }),
      ]),
    ),
  }),
]);

export const codeSessionDetailSchema = z.object({
  summary: codeSessionSummarySchema,
  messages: z.array(importedMessageSchema),
  notes: z.array(z.string()),
  sourceHash: z.string(),
});

export const codeSessionDetailEnvelopeSchema = z.object({ item: codeSessionDetailSchema });

export type CodeSessionClientState = z.infer<typeof codeSessionClientStateSchema>;
export type CodeSessionSummary = z.infer<typeof codeSessionSummarySchema>;
export type CodeSessionsList = z.infer<typeof codeSessionsListSchema>;
export type ImportedToolCall = z.infer<typeof importedToolCallSchema>;
export type ImportedMessage = z.infer<typeof importedMessageSchema>;
export type CodeSessionDetail = z.infer<typeof codeSessionDetailSchema>;

/** Display labels for the clients the Code tab can mirror. */
export const CODE_SESSION_CLIENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  pi: "Pi",
  opencode: "OpenCode",
};
