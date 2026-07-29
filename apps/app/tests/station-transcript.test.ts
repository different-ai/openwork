import { describe, expect, test } from "bun:test";

import { StationTranscriptAccumulator } from "../src/react-app/domains/station/station-transcript";

describe("Station transcript accumulator", () => {
  test("keeps creation order when completion events arrive out of order", () => {
    const transcript = new StationTranscriptAccumulator();
    transcript.markItem("first");
    transcript.markItem("second");
    transcript.complete("second", "Second turn.");
    const result = transcript.complete("first", "First turn.");
    expect(result.transcript).toBe("First turn.\nSecond turn.");
  });

  test("deduplicates repeated completion events for one Realtime item", () => {
    const transcript = new StationTranscriptAccumulator();
    expect(transcript.complete("turn", "Maya raised a privacy concern.").accepted).toBe(true);
    const repeated = transcript.complete("turn", "Maya raised a privacy concern.");
    expect(repeated.accepted).toBe(false);
    expect(repeated.transcript).toBe("Maya raised a privacy concern.");
  });

  test("preserves bounded prior context and replaces a corrected item", () => {
    const transcript = new StationTranscriptAccumulator(80);
    transcript.reset("Earlier context.");
    transcript.complete("turn", "Let’s meet Friday.");
    const corrected = transcript.complete("turn", "No, make that Monday.");
    expect(corrected.transcript).toContain("Earlier context.");
    expect(corrected.transcript).toContain("Monday");
    expect(corrected.transcript).not.toContain("Friday");
  });
});
