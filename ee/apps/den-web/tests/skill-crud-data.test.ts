import { describe, expect, test } from "bun:test";
import {
  createSkillPayload,
  parseSkillPayload,
} from "../app/(den)/dashboard/_components/skill-data";

describe("Den skill data", () => {
  test("round-trips the complete Markdown body through the shared skill format", () => {
    const body = [
      "# Incident handoff",
      "",
      "Keep the complete context visible:",
      "",
      "- Summarize impact",
      "- List owners and next steps",
      "",
      "```sh",
      "openwork verify-handoff",
      "```",
    ].join("\n");
    const payload = createSkillPayload("plugin-1", {
      name: "incident-handoff",
      description: "Prepare a careful incident handoff.",
      body,
    });
    const skill = parseSkillPayload({
      id: "config-object-1",
      objectType: "skill",
      title: "incident-handoff",
      description: "Prepare a careful incident handoff.",
      updatedAt: "2026-07-26T00:00:00.000Z",
      latestVersion: { rawSourceText: payload.input.rawSourceText },
    });

    expect(payload).toMatchObject({ type: "skill", sourceMode: "cloud", pluginIds: ["plugin-1"] });
    expect(skill?.name).toBe("incident-handoff");
    expect(skill?.description).toBe("Prepare a careful incident handoff.");
    expect(skill?.body).toBe(body);
  });

  test("rejects non-skill and incomplete config object payloads", () => {
    expect(parseSkillPayload({ objectType: "agent" })).toBeNull();
    expect(parseSkillPayload({ objectType: "skill", latestVersion: {} })).toBeNull();
  });
});
