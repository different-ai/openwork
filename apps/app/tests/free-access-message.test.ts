import { expect, test } from "bun:test";
import { autoAccessWallFromError, autoPickerCopy, autoWallCopy } from "../src/app/lib/inference-access";

test("a Free credential refusal explains access in both the conversation and the picker", () => {
  const wall = autoAccessWallFromError({ error: { code: "free_not_offered" } });
  expect(wall?.state).toBe("not_offered");
  if (!wall) throw new Error("Expected a Free access refusal");
  const copy = autoWallCopy(wall, true);
  expect(copy.title).toBe("You don’t have access to OpenWork Free in this organization");
  expect(copy.detail).toContain("admin");
  expect(copy.technicalDetails).toBe("Code: free_not_offered");
  expect(autoPickerCopy("not_offered", true, null, wall.code).detail).toBe(copy.detail);
});

test("an exhausted allowance still reports a usage limit", () => {
  const wall = autoAccessWallFromError({ code: "free_allowance_exhausted" });
  expect(wall?.state).toBe("limit");
  if (!wall) throw new Error("Expected an exhausted Free allowance");
  expect(autoWallCopy(wall, true).title).toBe("You’ve reached the OpenWork Free limit");
});

test("a sandbox that ended points the member to the platform admin", () => {
  const wall = autoAccessWallFromError({ code: "free_sandbox_ended" });
  if (!wall) throw new Error("Expected a sandbox access refusal");
  expect(wall.state).toBe("not_offered");
  expect(autoWallCopy(wall, true).title).toBe("This sandbox has ended");
  expect(autoPickerCopy("not_offered", true, null, wall.code).detail).toContain("reopen this sandbox");
});
