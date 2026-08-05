import { describe, expect, test } from "bun:test";

import {
  applyMaterializedBlueprintSessions,
  normalizeBlueprintSessionTemplates,
  readMaterializedBlueprintSessions,
  sanitizeMicxTemplateConfig,
} from "./blueprint-sessions.js";

describe("blueprint sessions", () => {
  test("normalizes configured session templates", () => {
    const sessions = normalizeBlueprintSessionTemplates({
      blueprint: {
        sessions: [
          {
            id: "welcome",
            title: "Welcome to Micx",
            openOnFirstLoad: true,
            messages: [
              { role: "assistant", text: "Hi welcome to Micx!" },
              { role: "user", text: "Help me get started." },
            ],
          },
        ],
      },
    });

    expect(sessions).toEqual([
      {
        id: "welcome",
        title: "Welcome to Micx",
        openOnFirstLoad: true,
        messages: [
          { role: "assistant", text: "Hi welcome to Micx!" },
          { role: "user", text: "Help me get started." },
        ],
      },
    ]);
  });

  test("sanitizes materialized session state from exported template config", () => {
    const sanitized = sanitizeMicxTemplateConfig({
      blueprint: {
        sessions: [{ id: "welcome", title: "Welcome", messages: [{ role: "assistant", text: "Hello" }] }],
        materialized: {
          sessions: {
            hydratedAt: 123,
            items: [{ templateId: "welcome", sessionId: "ses_123" }],
          },
        },
      },
    });

    expect(readMaterializedBlueprintSessions(sanitized)).toEqual([]);
    expect((sanitized.blueprint as Record<string, unknown>).sessions).toBeDefined();
  });

  test("applies materialized session mappings without removing templates", () => {
    const next = applyMaterializedBlueprintSessions(
      {
        blueprint: {
          sessions: [{ id: "welcome", title: "Welcome", messages: [{ role: "assistant", text: "Hello" }] }],
        },
      },
      [{ templateId: "welcome", sessionId: "ses_123" }],
      456,
    );

    expect(readMaterializedBlueprintSessions(next)).toEqual([{ templateId: "welcome", sessionId: "ses_123" }]);
    expect(((next.blueprint as Record<string, unknown>).materialized as Record<string, unknown>).sessions).toEqual({
      hydratedAt: 456,
      items: [{ templateId: "welcome", sessionId: "ses_123" }],
    });
  });
});
