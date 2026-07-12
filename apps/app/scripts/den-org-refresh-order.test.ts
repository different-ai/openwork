import { describe, expect, test } from "bun:test";

import { createLatestRequestGate } from "../src/react-app/domains/settings/cloud/use-den-session";

describe("createLatestRequestGate", () => {
  test("only the newest organization refresh remains current", () => {
    const gate = createLatestRequestGate();
    const older = gate.begin();
    const newer = gate.begin();

    expect(gate.isCurrent(older)).toBe(false);
    expect(gate.isCurrent(newer)).toBe(true);
  });

  test("a session identity change invalidates an in-flight refresh", () => {
    const gate = createLatestRequestGate();
    const request = gate.begin();
    gate.invalidate();

    expect(gate.isCurrent(request)).toBe(false);
  });

  test("stale success, error, and completion mutations are all rejected", async () => {
    const gate = createLatestRequestGate();
    const mutations: string[] = [];
    const older = gate.begin();
    const newer = gate.begin();

    if (gate.isCurrent(newer)) mutations.push("newer-success");
    if (gate.isCurrent(older)) mutations.push("older-success");
    if (gate.isCurrent(older)) mutations.push("older-error");
    if (gate.isCurrent(older)) mutations.push("older-complete");
    if (gate.isCurrent(newer)) mutations.push("newer-complete");

    expect(mutations).toEqual(["newer-success", "newer-complete"]);
  });
});
