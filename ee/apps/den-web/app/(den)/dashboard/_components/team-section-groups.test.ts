import assert from "node:assert/strict";
import { test } from "node:test";
import { groupTeamSections } from "./team-section-groups";

const section = (value: string) => ({ value });
const shape = (values: string[]) => groupTeamSections(values.map(section)).map((group) => [group.label, group.items.map((item) => item.value)]);

test("a team's sections sit under People, Permissions, AI and Apps", () => {
  assert.deepEqual(shape(["role", "overview", "access", "agents", "browser", "models", "workbot", "prompts", "desktop"]), [
    ["People", ["role", "overview"]],
    ["Permissions", ["access", "agents", "browser"]],
    ["AI", ["models", "workbot", "prompts"]],
    ["Apps", ["desktop"]],
  ]);
});

test("a group with no section to show is left out", () => {
  assert.deepEqual(shape(["role", "overview", "access"]), [
    ["People", ["role", "overview"]],
    ["Permissions", ["access"]],
  ]);
  // Everyone's page has no Members or Access.
  assert.deepEqual(shape(["role", "agents", "browser", "prompts"]), [
    ["People", ["role"]],
    ["Permissions", ["agents", "browser"]],
    ["AI", ["prompts"]],
  ]);
});

test("a section no group names is still listed, last", () => {
  assert.deepEqual(shape(["role", "billing"]), [
    ["People", ["role"]],
    ["More", ["billing"]],
  ]);
});
