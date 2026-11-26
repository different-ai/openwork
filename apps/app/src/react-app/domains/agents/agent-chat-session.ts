type SessionState = "open" | "gone" | "unknown";

export async function resolveAgentChatSession(input: {
  localSessionId: string | null;
  readPointer: () => Promise<string | null>;
  sessionState: (sessionId: string) => Promise<SessionState>;
  createSession: () => Promise<string | null>;
}) {
  const local = input.localSessionId;
  if (local && await input.sessionState(local) === "open") return { sessionId: local, source: "local" } as const;
  const pointer = await input.readPointer();
  if (pointer && pointer !== local && await input.sessionState(pointer) === "open") return { sessionId: pointer, source: "den" } as const;
  return { sessionId: await input.createSession(), source: "new" } as const;
}
