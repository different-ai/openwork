import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "ai";

import { DEFAULT_SHOW_THINKING } from "../src/react-app/kernel/local-provider";
import { SessionTranscript } from "../src/react-app/domains/session/surface/message-list";

describe("reasoning display", () => {
  test("defaults reasoning visibility on", () => {
    expect(DEFAULT_SHOW_THINKING).toBe(true);
  });

  test("renders reasoning as prose without a leading Thinking label", () => {
    const messages: UIMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "reasoning",
            text: "Thinking:\nWe should inspect the settings preference first.",
            state: "done",
          },
        ],
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(SessionTranscript, {
        messages,
        isStreaming: false,
        developerMode: false,
      }),
    );

    expect(html).toContain('data-reasoning="true"');
    expect(html).toContain("We should inspect the settings preference first.");
    expect(html).not.toContain("Thinking:");
    expect(html).not.toContain("font-mono");
  });
});
