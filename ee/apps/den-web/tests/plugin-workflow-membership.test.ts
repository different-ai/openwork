import { describe, expect, test } from "bun:test";
import { parseMembershipConfigObject } from "../app/(den)/dashboard/_components/plugin-data";

describe("resolved Plugin Workflow rows", () => {
  for (const objectType of ["script", "workflow"]) {
    test(`accepts ${objectType} without losing the saved version or schema`, () => {
      const inputSchema = { type: "object", properties: { asOf: { type: "string" } } };
      expect(parseMembershipConfigObject({ configObject: {
        id: "workflow-1", title: "Invoice follow-up", objectType,
        latestVersion: { id: "version-1", normalizedPayloadJson: { inputSchema } },
      } })).toMatchObject({ id: "workflow-1", title: "Invoice follow-up", objectType: "workflow",
        latestVersionId: "version-1", normalizedPayload: { inputSchema } });
    });
  }
  test("does not relabel other component types or accept absent projections", () => {
    expect(parseMembershipConfigObject({ configObject: { id: "skill-1", title: "Guidance", objectType: "skill" } })?.objectType).toBe("skill");
    expect(parseMembershipConfigObject({ configObject: null })).toBeNull();
  });
});
