import { describe, expect, test } from "bun:test";

import { stationGoalVoiceDecision } from "../src/react-app/domains/station/station-goal";

describe("Station intentional goal voice response", () => {
  test("recognizes short affirmative and negative replies", () => {
    expect(stationGoalVoiceDecision("Yes, go ahead.")).toBe("approve");
    expect(stationGoalVoiceDecision("Look into it")).toBe("approve");
    expect(stationGoalVoiceDecision("No, don't do that.")).toBe("dismiss");
    expect(stationGoalVoiceDecision("Not now")).toBe("dismiss");
  });

  test("does not mistake ordinary conversation for approval", () => {
    expect(stationGoalVoiceDecision("Yesterday we discussed whether to go ahead with the launch.")).toBeNull();
    expect(stationGoalVoiceDecision("This is a longer explanation about a different topic entirely.")).toBeNull();
  });
});
