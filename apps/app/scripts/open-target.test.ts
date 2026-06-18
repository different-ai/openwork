import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";

import {
  deriveOpenTargets,
  isCollectibleArtifactTarget,
  selectAutoOpenTarget,
} from "../src/react-app/domains/session/artifacts/open-target";

function message(id: string, role: "user" | "assistant", text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text, state: "done" }] };
}

function toolMessage(id: string, toolName: string, input: Record<string, unknown>, output: unknown) {
  return {
    id,
    role: "assistant",
    parts: [{
      type: "dynamic-tool",
      toolName,
      toolCallId: `${id}_tool`,
      state: "output-available",
      input,
      output,
    }],
  };
}

describe("deriveOpenTargets", () => {
  it("extracts file and localhost URL targets from recent assistant output", () => {
    const targets = deriveOpenTargets([
      toolMessage("msg_tool", "write", { filePath: "reports/revenue.xlsx" }, { filePath: "reports/revenue.xlsx" }),
      message("msg_1", "assistant", "Created reports/revenue.xlsx and started http://localhost:5173 for preview."),
    ]);

    expect(targets.map((target) => target.value)).toContain("reports/revenue.xlsx");
    expect(targets.map((target) => target.value)).toContain("http://localhost:5173");
    expect(targets.find((target) => target.value === "reports/revenue.xlsx")?.preview).toBe("sheet");
  });

  it("extracts websocket URLs so local socket/dev-server hints stay visible", () => {
    const targets = deriveOpenTargets([
      toolMessage("msg_tool", "write", { filePath: "dist/index.html" }, { filePath: "dist/index.html" }),
      message("msg_1", "assistant", "Socket open at ws://localhost:5173/socket and preview at dist/index.html"),
    ]);

    expect(targets.map((target) => target.value)).toContain("ws://localhost:5173/socket");
    expect(targets.map((target) => target.value)).toContain("dist/index.html");
  });

  it("normalizes Workspace/<id>/ prefixes from artifact paths", () => {
    const targets = deriveOpenTargets([
      toolMessage("msg_tool_1", "write", { filePath: "Workspace/32423/reports/artifact-eval.md" }, { filePath: "Workspace/32423/reports/artifact-eval.md" }),
      toolMessage("msg_tool_2", "write", { filePath: "Workspace/32423/reports/artifact-eval.csv" }, { filePath: "Workspace/32423/reports/artifact-eval.csv" }),
      message("msg_1", "assistant", "See Workspace/32423/reports/artifact-eval.md and Workspace/32423/reports/artifact-eval.csv"),
    ]);

    expect(targets.map((target) => target.value)).toContain("reports/artifact-eval.md");
    expect(targets.map((target) => target.value)).toContain("reports/artifact-eval.csv");
  });

  it("prefers explicit dynamic tool metadata over prose guesses", () => {
    const targets = deriveOpenTargets([
      toolMessage("msg_tool", "write", { path: "summary.md" }, { path: "summary.md" }),
    ]);

    expect(targets[0]).toMatchObject({ value: "summary.md", preview: "markdown", confidence: 95 });
  });

  it("extracts filePath metadata from write tools", () => {
    const targets = deriveOpenTargets([
      toolMessage("msg_tool", "write", { filePath: "reports/summary.md" }, { filePath: "reports/summary.md" }),
    ]);

    expect(targets[0]).toMatchObject({ value: "reports/summary.md", preview: "markdown", confidence: 95 });
  });

  it("keeps written unsupported files available for opening externally", () => {
    const targets = deriveOpenTargets([
      toolMessage("msg_tool", "write", { filePath: "src/widget.tsx" }, { filePath: "src/widget.tsx" }),
    ]);

    const target = targets[0];

    expect(target).toMatchObject({ value: "src/widget.tsx", preview: "text", confidence: 95 });
    expect(target ? isCollectibleArtifactTarget({ ...target, exists: true }) : true).toBe(false);
  });

  it("uses markdown link href once when the label is the href basename", () => {
    const targets = deriveOpenTargets([
      message("msg_1", "assistant", "I generated the file [native-link.txt](reports/native-link.txt)."),
    ]);

    expect(targets.map((target) => target.value)).toEqual(["reports/native-link.txt"]);
  });

  it("keeps distinct markdown link labels as normal file mentions", () => {
    const targets = deriveOpenTargets([
      message("msg_1", "assistant", "I generated the file [summary.md](reports/native-link.txt)."),
    ]);

    expect(targets.map((target) => target.value).sort()).toEqual(["reports/native-link.txt", "summary.md"]);
  });

  it("extracts PowerPoint decks from assistant artifact summaries", () => {
    const targets = deriveOpenTargets([
      message("msg_1", "assistant", "Updated file: decks/openwork-vertebrae-deck.pptx"),
    ]);
    const deck = targets.find((target) => target.value === "decks/openwork-vertebrae-deck.pptx");

    expect(deck).toMatchObject({ preview: "slides", confidence: 65 });
    expect(deck ? isCollectibleArtifactTarget({ ...deck, exists: true }) : false).toBe(true);
  });

  it("extracts artifact paths from OpenWork extension call metadata", () => {
    const targets = deriveOpenTargets([
      toolMessage("msg_tool", "openwork_extension_call", {
        extensionId: "openai-image-generation",
        action: "image_generate",
      }, {
        ok: true,
        extensionId: "openai-image-generation",
        action: "image_generate",
        path: "artifacts/potato.png",
        result: {
          path: "artifacts/potato.png",
          bytes: 12345,
          model: "gpt-image-2",
        },
      }),
    ]);

    expect(targets[0]).toMatchObject({ value: "artifacts/potato.png", preview: "image", confidence: 95 });
  });

  it("extracts artifact targets from attachment sources", () => {
    const targets = deriveOpenTargets([
      {
        id: "msg_attachment",
        role: "assistant",
        parts: [{
          type: "source-document",
          sourceId: "attachment-source",
          mediaType: "text/csv",
          title: "customers.csv",
          filename: "reports/customers.csv",
        }],
      },
    ]);

    expect(targets[0]).toMatchObject({ value: "reports/customers.csv", preview: "sheet", confidence: 95 });
  });

  it("keeps URI-backed source documents as URL targets when filename is missing", () => {
    const targets = deriveOpenTargets([
      {
        id: "msg_source",
        role: "assistant",
        parts: [{
          type: "source-document",
          sourceId: "url-source",
          mediaType: "text/html",
          title: "https://example.com/docs/report.html",
        }],
      },
    ]);

    expect(targets[0]).toMatchObject({ kind: "url", value: "https://example.com/docs/report.html", preview: "browser" });
  });

  it("does not extract file artifacts from read tool metadata or output", () => {
    const targets = deriveOpenTargets([
      toolMessage(
        "msg_tool",
        "read",
        { filePath: "reports/source.md" },
        { content: "Reviewed reports/source.md and referenced reports/source.csv" },
      ),
      message("msg_2", "assistant", "Reviewed reports/source.md and reports/source.csv."),
    ]);

    expect(targets.map((target) => target.value)).not.toContain("reports/source.md");
    expect(targets.map((target) => target.value)).not.toContain("reports/source.csv");
  });

  it("extracts paths written by apply_patch metadata", () => {
    const targets = deriveOpenTargets([
      toolMessage("msg_tool", "apply_patch", {
        patchText: "*** Begin Patch\n*** Add File: reports/new-report.md\n+hello\n*** Update File: reports/existing-report.csv\n@@\n-old\n+new\n*** End Patch",
      }, "Success. Updated files."),
    ]);

    expect(targets.map((target) => target.value)).toContain("reports/new-report.md");
    expect(targets.map((target) => target.value)).toContain("reports/existing-report.csv");
  });

  it("does not turn package search results into artifacts", () => {
    const targets = deriveOpenTargets([
      toolMessage("msg_tool", "glob", { pattern: "**/package.json" }, {
        files: [
          "package.json",
          "apps/app/package.json",
          "packages/ui/package.json",
          "reports/revenue.csv",
        ],
      }),
      message("msg_2", "assistant", "Found package.json, apps/app/package.json, and reports/revenue.csv"),
    ]);

    expect(targets.map((target) => target.value)).not.toContain("package.json");
    expect(targets.map((target) => target.value)).not.toContain("apps/app/package.json");
    expect(targets.map((target) => target.value)).not.toContain("packages/ui/package.json");
    expect(targets.map((target) => target.value)).not.toContain("reports/revenue.csv");
  });

  it("does not turn discovery tool markdown listings into artifacts", () => {
    const targets = deriveOpenTargets([
      toolMessage("msg_write", "write", { filePath: "reports/created-report.md" }, { filePath: "reports/created-report.md" }),
      toolMessage("msg_tool", "glob", { pattern: "**/*.md" }, {
        files: [
          "README.md",
          ".opencode/skills/example/SKILL.md",
          "reports/created-report.md",
        ],
      }),
      message("msg_2", "assistant", "Created reports/created-report.md as the deliverable."),
    ]);

    expect(targets.map((target) => target.value)).toContain("reports/created-report.md");
    expect(targets.map((target) => target.value)).not.toContain("README.md");
    expect(targets.map((target) => target.value)).not.toContain(".opencode/skills/example/SKILL.md");
  });

  it("does not collect server-verified missing file targets", () => {
    const target = deriveOpenTargets([
      toolMessage("msg_tool", "write", { filePath: "index.html" }, { filePath: "index.html" }),
      message("msg_1", "assistant", "Preview file: index.html"),
    ])[0];

    expect(target).toMatchObject({ value: "index.html", preview: "html" });
    expect(isCollectibleArtifactTarget({ ...target, exists: false })).toBe(false);
    expect(isCollectibleArtifactTarget({ ...target, exists: true })).toBe(true);
  });

  it("does not auto-open generated html files or localhost browser previews", () => {
    const targets = deriveOpenTargets([
      toolMessage("msg_tool", "write", { filePath: "public/index.html" }, { filePath: "public/index.html" }),
      message("msg_1", "assistant", "Created public/index.html. API: `http://localhost:3000/api/info`. App: `http://localhost:3000`."),
    ]).map((target) => ({ ...target, exists: target.kind === "url" || target.value === "public/index.html" }));

    expect(targets.map((target) => target.value)).toContain("http://localhost:3000/api/info");
    expect(targets.map((target) => target.value)).toContain("http://localhost:3000");
    expect(selectAutoOpenTarget(targets)).toBeNull();
  });

  it("normalizes escaped localhost root URL variants into one target", () => {
    const targets = deriveOpenTargets([
      message("msg_1", "assistant", "App: `http://localhost:3000/\\` and also http://localhost:3000//"),
    ]);

    expect(targets.filter((target) => target.value === "http://localhost:3000")).toHaveLength(1);
    expect(targets.map((target) => target.name)).not.toContain("\\");
  });

  it("keeps accessible targets from earlier session messages", () => {
    const targets = deriveOpenTargets([
      toolMessage("msg_tool", "write", { filePath: "reports/earlier.csv" }, { filePath: "reports/earlier.csv" }),
      message("msg_1", "assistant", "Created reports/earlier.csv"),
      ...Array.from({ length: 12 }, (_, index) => message(`msg_noise_${index}`, "assistant", `Status update ${index + 1}`)),
      message("msg_last", "assistant", "Server running at http://localhost:3000"),
    ]);

    expect(targets.map((target) => target.value)).toContain("reports/earlier.csv");
    expect(targets.map((target) => target.value)).toContain("http://localhost:3000");
  });

  it("does not auto-open high-confidence deliverables or browser previews", () => {
    const targets = deriveOpenTargets([
      toolMessage("msg_tool", "write", { filePath: "data/customers.csv" }, { filePath: "data/customers.csv" }),
      message("msg_1", "assistant", "Created data/customers.csv and see https://example.com for docs."),
    ]).map((target) => ({ ...target, exists: target.kind === "file" }));

    expect(selectAutoOpenTarget(targets)).toBeNull();
  });
});
