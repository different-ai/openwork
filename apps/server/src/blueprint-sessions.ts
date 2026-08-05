type BlueprintSessionMessage = {
  role: "assistant" | "user";
  text: string;
};

export type BlueprintSessionTemplate = {
  id: string;
  title: string;
  messages: BlueprintSessionMessage[];
  openOnFirstLoad: boolean;
};

export type MaterializedBlueprintSession = {
  templateId: string;
  sessionId: string;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function normalizeMessage(value: unknown): BlueprintSessionMessage | null {
  const record = readRecord(value);
  if (!record) return null;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) return null;
  const role = String(record.role ?? "assistant").trim().toLowerCase() === "user" ? "user" : "assistant";
  return { role, text };
}

export function normalizeBlueprintSessionTemplates(micx: Record<string, unknown> | null | undefined): BlueprintSessionTemplate[] {
  const blueprint = readRecord(micx?.blueprint);
  const sessions = Array.isArray(blueprint?.sessions) ? blueprint?.sessions : [];
  return sessions
    .map((value, index) => {
      const record = readRecord(value);
      if (!record) return null;
      const title = typeof record.title === "string" ? record.title.trim() : "";
      const messages = Array.isArray(record.messages)
        ? record.messages.map(normalizeMessage).filter((item): item is BlueprintSessionMessage => Boolean(item))
        : [];
      if (!title && messages.length === 0) return null;
      const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : `template-session-${index + 1}`;
      return {
        id,
        title: title || `Template session ${index + 1}`,
        messages,
        openOnFirstLoad: record.openOnFirstLoad === true,
      } satisfies BlueprintSessionTemplate;
    })
    .filter((item): item is BlueprintSessionTemplate => Boolean(item));
}

export function readMaterializedBlueprintSessions(micx: Record<string, unknown> | null | undefined): MaterializedBlueprintSession[] {
  const blueprint = readRecord(micx?.blueprint);
  const materialized = readRecord(blueprint?.materialized);
  const sessions = readRecord(materialized?.sessions);
  const items = Array.isArray(sessions?.items) ? sessions.items : [];
  return items
    .map((value) => {
      const record = readRecord(value);
      if (!record) return null;
      const templateId = typeof record.templateId === "string" ? record.templateId.trim() : "";
      const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
      if (!templateId || !sessionId) return null;
      return { templateId, sessionId } satisfies MaterializedBlueprintSession;
    })
    .filter((item): item is MaterializedBlueprintSession => Boolean(item));
}

export function sanitizeMicxTemplateConfig(micx: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const next = cloneRecord(micx ?? {});
  const blueprint = readRecord(next.blueprint);
  if (!blueprint) return next;

  const materialized = readRecord(blueprint.materialized);
  if (materialized) {
    delete materialized.sessions;
    if (Object.keys(materialized).length === 0) {
      delete blueprint.materialized;
    } else {
      blueprint.materialized = materialized;
    }
  }

  next.blueprint = blueprint;
  return next;
}

export function applyMaterializedBlueprintSessions(
  micx: Record<string, unknown> | null | undefined,
  items: MaterializedBlueprintSession[],
  hydratedAt: number,
): Record<string, unknown> {
  const next = sanitizeMicxTemplateConfig(micx);
  const blueprint = readRecord(next.blueprint) ?? {};
  const materialized = readRecord(blueprint.materialized) ?? {};
  materialized.sessions = {
    hydratedAt,
    items: items.map((item) => ({ ...item })),
  };
  blueprint.materialized = materialized;
  next.blueprint = blueprint;
  return next;
}
