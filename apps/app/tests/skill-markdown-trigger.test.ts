import { describe, expect, test } from "bun:test";

import { extractSkillTriggerFromMarkdown } from "@openwork/types/skill-markdown";

describe("skill markdown trigger extraction", () => {
  test("returns frontmatter trigger, quoted trigger, and when values", () => {
    expect(extractSkillTriggerFromMarkdown("---\ntrigger: Review high-priority requests\n---\n# Review"))
      .toBe("Review high-priority requests");
    expect(extractSkillTriggerFromMarkdown("---\ntrigger: 'Review high-priority requests'\n---\n# Review"))
      .toBe("Review high-priority requests");
    expect(extractSkillTriggerFromMarkdown("---\ntrigger: \"Review high-priority requests\"\n---\n# Review"))
      .toBe("Review high-priority requests");
    expect(extractSkillTriggerFromMarkdown("---\nwhen: Prepare release notes\n---\n# Release"))
      .toBe("Prepare release notes");
  });

  test("ignores nested keys and unreadable scalar values", () => {
    expect(extractSkillTriggerFromMarkdown("---\nmetadata:\n  trigger: Nested value\n---\n# Review"))
      .toBeUndefined();
    expect(extractSkillTriggerFromMarkdown("---\ntrigger: |\n  Multi-line trigger\n---\n# Review"))
      .toBeUndefined();
  });

  test("returns the first When to use item and omits absent triggers", () => {
    expect(extractSkillTriggerFromMarkdown("# Review\n\n## When to use\n- Triage incoming requests\n- Draft replies"))
      .toBe("Triage incoming requests");
    expect(extractSkillTriggerFromMarkdown("# Review\n\nUse this skill carefully."))
      .toBeUndefined();
  });
});
