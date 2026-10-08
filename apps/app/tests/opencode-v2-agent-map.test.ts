import { describe, expect, test } from "bun:test";
import { mapV2Agent } from "../src/app/lib/opencode-v2-adapter";
import { isLibraryAgent } from "../src/react-app/domains/settings/library";

describe("mapV2Agent", () => {
  test("maps primary agents with API id as name for picker selection", () => {
    const build = mapV2Agent({
      id: "build",
      name: "Build",
      description: "The default agent.",
      mode: "primary",
      hidden: false,
      permissions: [],
    });
    expect(build).toEqual({
      name: "build",
      description: "The default agent.",
      mode: "primary",
      hidden: false,
      permission: [],
      options: {},
    });
    expect(isLibraryAgent(build!)).toBe(true);
  });

  test("keeps plan selectable and drops hidden/subagent rows from library filter", () => {
    const plan = mapV2Agent({
      id: "plan",
      name: "Plan",
      mode: "primary",
      hidden: false,
    });
    const explore = mapV2Agent({
      id: "explore",
      name: "Explore",
      mode: "subagent",
      hidden: false,
    });
    const title = mapV2Agent({
      id: "title",
      name: "Title",
      mode: "primary",
      hidden: true,
    });
    expect(plan?.name).toBe("plan");
    expect(isLibraryAgent(plan!)).toBe(true);
    expect(isLibraryAgent(explore!)).toBe(false);
    expect(isLibraryAgent(title!)).toBe(false);
  });

  test("rejects malformed rows", () => {
    expect(mapV2Agent(null)).toBeNull();
    expect(mapV2Agent({ name: "Build", mode: "primary" })).toBeNull();
    expect(mapV2Agent({ id: "build", mode: "other" })).toBeNull();
  });
});
