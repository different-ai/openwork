import { describe, expect, test } from "bun:test";

import { buildStationThreadHandoff } from "../src/react-app/domains/station/station-handoff";
import type { StationSuggestion } from "../src/react-app/domains/station/station-types";

function suggestion(): StationSuggestion {
  return {
    id: "follow-up",
    kind: "follow_up",
    title: "Follow up with Maya",
    summary: "Maya needs the reviewed retention boundary.",
    reason: "You promised a response after the call.",
    relevance: 0.92,
    effectiveRelevance: 0.94,
    color: "#FF9F5A",
    sources: [{
      label: "Maya · enterprise launch",
      provider: "Slack",
      url: "https://example.com/slack/42",
    }],
    action: {
      kind: "review_draft",
      label: "Review follow-up",
      draft: "Hi Maya, here is the boundary for review.",
    },
    createdAt: 1,
  };
}

describe("Station thread handoff", () => {
  test("carries the context, reason, evidence, and unsent draft into OpenWork", () => {
    const handoff = buildStationThreadHandoff(suggestion());
    expect(handoff.title).toBe("Follow up with Maya");
    expect(handoff.prompt).toContain("This task was started by OpenWork Station");
    expect(handoff.prompt).toContain("Maya needs the reviewed retention boundary");
    expect(handoff.prompt).toContain("Slack: Maya · enterprise launch");
    expect(handoff.prompt).toContain("Prepared draft (not sent or applied)");
    expect(handoff.prompt).toContain("Keep every external action under my review");
    expect(handoff.transcriptRecord).toBeNull();
  });

  test("creates a bounded, openable transcript checkpoint only when enabled", () => {
    const handoff = buildStationThreadHandoff(suggestion(), {
      transcript: `Earlier context\n${"relevant ".repeat(1_200)}`,
      includeTranscriptRecord: true,
      capturedAt: Date.parse("2026-07-29T12:00:00.000Z"),
    });
    expect(handoff.transcriptRecord?.filename).toBe("openwork-station-2026-07-29T12-00-00-000Z.md");
    expect(handoff.transcriptRecord?.mimeType).toBe("text/markdown");
    expect(handoff.transcriptRecord?.content).toContain("OpenWork Station transcript checkpoint");
    expect(handoff.transcriptRecord?.content).toContain("Relevant live transcript");
    expect(handoff.transcriptRecord?.content.length).toBeLessThan(9_000);
    expect(handoff.prompt).toContain("Transcript checkpoint: attached");
  });
});
