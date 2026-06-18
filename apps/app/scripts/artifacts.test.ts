import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";

import type { OpenTarget } from "../src/react-app/domains/session/artifacts/open-target";
import { canOpenArtifact, canPreviewArtifact, getArtifactsFromMessages } from "../src/lib/artifacts";

describe("getArtifactsFromMessages", () => {
  it("includes verified slide deck targets mentioned in assistant summaries", () => {
    const messages: UIMessage[] = [{
      id: "msg_deck",
      role: "assistant",
      parts: [{ type: "text", text: "Updated file: decks/openwork-vertebrae-deck.pptx", state: "done" }],
    }];
    const targets: OpenTarget[] = [{
      id: "file:decks/openwork-vertebrae-deck.pptx",
      kind: "file",
      value: "decks/openwork-vertebrae-deck.pptx",
      name: "openwork-vertebrae-deck.pptx",
      preview: "slides",
      confidence: 65,
      reason: "message",
      exists: true,
    }];

    expect(getArtifactsFromMessages(messages, targets)[0]).toMatchObject({
      name: "openwork-vertebrae-deck.pptx",
      path: "decks/openwork-vertebrae-deck.pptx",
      type: "slides",
      legacy_target: { preview: "slides", exists: true },
    });
  });

  it("uses verified relative targets for absolute attachment paths", () => {
    const messages: UIMessage[] = [{
      id: "msg_attachment",
      role: "assistant",
      parts: [{
        type: "source-document",
        sourceId: "attachment-source",
        mediaType: "text/csv",
        title: "customers.csv",
        filename: "/Users/test/workspace/customers.csv",
      }],
    }];
    const targets: OpenTarget[] = [{
      id: "file:customers.csv",
      kind: "file",
      value: "customers.csv",
      name: "customers.csv",
      preview: "sheet",
      confidence: 95,
      reason: "attachment source",
      exists: true,
    }];

    expect(getArtifactsFromMessages(messages, targets)[0]?.legacy_target).toMatchObject({
      value: "customers.csv",
      exists: true,
    });
  });

  it("can list artifacts from assistant text without target fallbacks", () => {
    const messages: UIMessage[] = [{
      id: "msg_text",
      role: "assistant",
      parts: [{ type: "text", text: "Created reports/artifact-eval.md, decks/update.pptx, and src/widget.tsx", state: "done" }],
    }];

    expect(getArtifactsFromMessages(messages, [], { includeTargetFallbacks: false }).map((artifact) => artifact.path)).toEqual([
      "src/widget.tsx",
      "decks/update.pptx",
      "reports/artifact-eval.md",
    ]);
  });

  it("orders verified artifacts by newest update time and marks unsupported previews", () => {
    const messages: UIMessage[] = [{
      id: "msg_order",
      role: "assistant",
      parts: [{ type: "text", text: "Created reports/old.md and reports/new.md and src/widget.tsx", state: "done" }],
    }];
    const targets: OpenTarget[] = [
      {
        id: "file:reports/old.md",
        kind: "file",
        value: "reports/old.md",
        name: "old.md",
        preview: "markdown",
        confidence: 65,
        reason: "message",
        exists: true,
        updatedAt: 1,
      },
      {
        id: "file:reports/new.md",
        kind: "file",
        value: "reports/new.md",
        name: "new.md",
        preview: "markdown",
        confidence: 65,
        reason: "message",
        exists: true,
        updatedAt: 2,
      },
    ];

    const artifacts = getArtifactsFromMessages(messages, targets, { includeTargetFallbacks: false });

    expect(artifacts.map((artifact) => artifact.path)).toEqual(["reports/new.md", "reports/old.md", "src/widget.tsx"]);
    expect(canPreviewArtifact(artifacts[0])).toBe(true);
    expect(canPreviewArtifact(artifacts[2])).toBe(false);
  });

  it("lets verified unsupported file artifacts open outside the sidebar", () => {
    const messages: UIMessage[] = [{
      id: "msg_unsupported",
      role: "assistant",
      parts: [{ type: "text", text: "Created src/widget.tsx", state: "done" }],
    }];
    const targets: OpenTarget[] = [{
      id: "file:src/widget.tsx",
      kind: "file",
      value: "src/widget.tsx",
      name: "widget.tsx",
      preview: "text",
      confidence: 65,
      reason: "message",
      exists: true,
    }];

    const artifact = getArtifactsFromMessages(messages, targets, { includeTargetFallbacks: false })[0];

    expect(artifact).toMatchObject({ path: "src/widget.tsx", legacy_target: { exists: true, preview: "text" } });
    expect(artifact ? canPreviewArtifact(artifact) : true).toBe(false);
    expect(artifact ? canOpenArtifact(artifact) : false).toBe(true);
  });
});
