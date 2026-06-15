import { describe, expect, test } from "bun:test";

import { formatComposerAgentLabel } from "../src/react-app/domains/session/surface/composer/agent-label";

describe("formatComposerAgentLabel", () => {
  test("relabels the built-in build agent to a friendly name", () => {
    expect(formatComposerAgentLabel("build")).toBe("General purpose agent");
  });

  test("capitalizes custom / non-mapped agent names", () => {
    expect(formatComposerAgentLabel("plan")).toBe("Plan");
    expect(formatComposerAgentLabel("reviewer")).toBe("Reviewer");
  });
});
