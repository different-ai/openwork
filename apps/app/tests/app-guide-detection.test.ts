import { expect, test } from "bun:test";
import type { DynamicToolUIPart } from "ai";
import { isAppGuidePart } from "../src/react-app/domains/apps/app-creation-progress";

const part = (toolName: string, input: unknown) => ({
  type: "dynamic-tool",
  toolName,
  toolCallId: "call-1",
  state: "input-available",
  input,
}) as DynamicToolUIPart;

test("reading build-an-app through get_skill or the native skill tool starts App progress", () => {
  expect(isAppGuidePart(part("openwork-cloud_get_skill", { name: "build-an-app" }))).toBe(true);
  expect(isAppGuidePart(part("get_skill", { name: "skill:build-an-app" }))).toBe(true);
  expect(isAppGuidePart(part("skill", { id: "openwork-cloud-build-an-app" }))).toBe(true);
});

test("other skills are not the App guide", () => {
  expect(isAppGuidePart(part("skill", { id: "openwork-cloud-drive-files" }))).toBe(false);
  expect(isAppGuidePart(part("skill", { id: "my-build-an-app" }))).toBe(false);
});
