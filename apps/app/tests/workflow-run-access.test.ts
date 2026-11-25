import { expect, test } from "bun:test";
import { canScheduleWorkflow } from "../src/app/lib/workflow-run-access";

test("manual viewer execution never grants scheduling access", () => {
  expect(canScheduleWorkflow("viewer")).toBe(false);
  expect(canScheduleWorkflow("editor")).toBe(true);
  expect(canScheduleWorkflow("manager")).toBe(true);
  for (const role of [null, undefined, "owner", "admin", "", {}, true]) expect(canScheduleWorkflow(role)).toBe(false);
});
