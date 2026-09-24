import { expect, test } from "bun:test";
import { pluginDirectoryRange, pluginDirectoryUrlParams } from "../app/(den)/dashboard/_components/admin-plugins-screen";
import { pluginDirectoryParams, pluginDirectoryQueryKey } from "../app/(den)/dashboard/_components/plugin-data";

test("plugin directory requests scope every cursor page to the selected audience and name", () => {
  const filters = { q: "call & prep", teamId: "team_1", memberId: null };
  const first = pluginDirectoryParams(filters, "");
  const next = pluginDirectoryParams(filters, "opaque-cursor");
  expect(first.get("limit")).toBe("50");
  expect(first.get("name")).toBe("call & prep");
  expect(first.get("teamId")).toBe("team_1");
  expect(first.get("includeTotal")).toBe("true");
  expect(first.get("includeFacets")).toBe("true");
  expect(first.has("cursor")).toBe(false);
  expect(next.get("cursor")).toBe("opaque-cursor");
  expect(next.has("includeTotal")).toBe(false);
  expect(next.has("includeFacets")).toBe(false);
  expect(next.get("teamId")).toBe("team_1");
  expect(pluginDirectoryParams({ q: "", teamId: null, memberId: "member_1" }, "").get("memberId")).toBe("member_1");
});

test("directory cache and URL preserve organization boundaries and filters", () => {
  const filters = { q: "call", teamId: "team_1", memberId: null };
  expect(pluginDirectoryQueryKey("org_a", "member_a", filters)).not.toEqual(pluginDirectoryQueryKey("org_b", "member_a", filters));
  expect(pluginDirectoryQueryKey("org_a", "member_a", filters)).not.toEqual(pluginDirectoryQueryKey("org_a", "member_b", filters));
  const selected = pluginDirectoryUrlParams("view=plugins&other=keep", { name: "call", teamId: "team_1", memberId: null });
  expect(new URLSearchParams(selected).get("other")).toBe("keep");
  expect(new URLSearchParams(selected).get("name")).toBe("call");
  expect(new URLSearchParams(selected).get("teamId")).toBe("team_1");
  expect(new URLSearchParams(pluginDirectoryUrlParams(selected, { name: "", teamId: null, memberId: "member_1" })).get("teamId")).toBeNull();
});

test("plugin directory windows deep rows without mounting the full list", () => {
  expect(pluginDirectoryRange(0, 544, 68, 1204)).toEqual({ start: 0, end: 12 });
  const deep = pluginDirectoryRange(68 * 1000, 544, 68, 1204);
  expect(deep.start).toBe(996);
  expect(deep.end).toBe(1012);
  expect(deep.end - deep.start).toBeLessThan(20);
  expect(pluginDirectoryRange(68 * 1200, 544, 68, 1204).end).toBe(1204);
});


test("owner is independent from the team audience and scopes every cursor page", () => {
  const filters = { q: "call", teamId: "team_1", memberId: null, ownerId: "member_1" };
  for (const cursor of ["", "next-page"]) {
    const params = pluginDirectoryParams(filters, cursor);
    expect(params.get("ownerId")).toBe("member_1");
    expect(params.get("teamId")).toBe("team_1");
    expect(params.has("memberId")).toBe(false);
  }
  expect(pluginDirectoryQueryKey("org_a", "viewer", filters)).not.toEqual(pluginDirectoryQueryKey("org_a", "viewer", { ...filters, ownerId: "member_2" }));
  const params = pluginDirectoryUrlParams("", { name: "call", teamId: "team_1", memberId: null, ownerId: "member_1" });
  expect(new URLSearchParams(params).get("ownerId")).toBe("member_1");
  const cleared = pluginDirectoryUrlParams(params, { name: "", teamId: null, memberId: null, ownerId: null });
  expect(cleared).toBe("");
});
