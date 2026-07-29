import { describe, expect, test } from "bun:test";

import { stationThreadComposerInput } from "../src/react-app/domains/station/station-thread-attachment";

describe("Station task transcript attachment", () => {
  test("turns a transcript record into a normal OpenWork document attachment", async () => {
    const input = stationThreadComposerInput({
      title: "Context",
      prompt: "Continue this context.",
      transcriptRecord: {
        filename: "openwork-station-checkpoint.md",
        mimeType: "text/markdown",
        content: "# Checkpoint\n\nRelevant words",
      },
    }, "station-record");
    expect(input.prompt).toContain("[attachment station-record]");
    expect(input.attachments).toHaveLength(1);
    expect(input.attachments[0]?.kind).toBe("file");
    expect(input.attachments[0]?.name).toBe("openwork-station-checkpoint.md");
    expect(await input.attachments[0]?.file.text()).toContain("Relevant words");
  });

  test("leaves handoffs without transcript records untouched", () => {
    const input = stationThreadComposerInput({
      title: "Context",
      prompt: "Continue this context.",
      transcriptRecord: null,
    }, "unused");
    expect(input).toEqual({ prompt: "Continue this context.", attachments: [] });
  });
});
