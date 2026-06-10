import { describe, expect, test } from "bun:test";

import { appMentionInstruction } from "../src/react-app/domains/session/surface/composer/app-mentions";
import { decodeComposerMentionValue, encodeComposerMentionValue } from "../src/react-app/domains/session/surface/composer/mention-encoding";

describe("app-mentions", () => {
  test("instruction names the app and steers to a computer-use snapshot", () => {
    const instruction = appMentionInstruction("Music");
    expect(instruction).toContain('"Music"');
    expect(instruction).toContain("computer-use");
    expect(instruction).toContain('snapshot {"app": "Music"}');
  });

  test("app names with spaces round-trip through mention encoding", () => {
    const value = "Visual Studio Code";
    const encoded = encodeComposerMentionValue(value);
    expect(encoded).toBe("Visual%20Studio%20Code");
    expect(decodeComposerMentionValue(encoded)).toBe(value);
  });
});
