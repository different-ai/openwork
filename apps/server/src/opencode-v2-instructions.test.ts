import { expect, test } from "bun:test";

import { buildOpenWorkV2Instructions } from "./opencode-v2-instructions.js";

test("v2 discovers remote skills on demand and keeps local skills native", () => {
  const connected = buildOpenWorkV2Instructions(true);
  expect(connected.operatingInstructions).toContain("remote skills");
  expect(connected.skillInstructions).toContain("OpenWork Connect");
  expect(connected.skillInstructions).toContain("on demand");
  expect(JSON.stringify(connected)).not.toContain("<available_remote_skills>");
});
