import { describe, expect, test } from "bun:test";

import {
  INITIAL_STATION_RUNTIME,
  OPENWORK_STATION_REALTIME_MODEL,
  transitionStationRuntime,
} from "../src";

describe("@openwork/station", () => {
  test("owns the reusable runtime contract", () => {
    const starting = transitionStationRuntime(INITIAL_STATION_RUNTIME, {
      type: "start_requested",
      at: 1,
    });
    expect(starting.phase).toBe("requesting_microphone");
    expect(OPENWORK_STATION_REALTIME_MODEL).toBe("gpt-realtime-2.1");
  });
});
